// Composition root: the one place that creates the transport clients and wires them to the store.
// Startup order: WS connect → register → `registered` (our id → REST client) → load fleet + routes → SSE connect.
// Then: fleet refresh every 30 s (retry + circuit breaker → "stale" flag), reload on `fleet_reset` and after an
// SSE reconnect (missed data can't be replayed). stop() cleans up everything.
import type { WsServerMessage } from '../domain/events';
import { isRouteMessage } from '../domain/routes';
import { createRouteActions, type RouteActions } from './routeActions';
import type { FleetState } from '../store/fleetStore';
import { CircuitBreaker } from '../transport/circuitBreaker';
import type { ConnectionStatus } from '../transport/connection';
import { RestClient, type FetchFn } from '../transport/restClient';
import { withRetry } from '../transport/retry';
import { SseClient, type EventSourceFactory } from '../transport/sseClient';
import { WsClient, type DispatcherIdStore, type WebSocketFactory } from '../transport/wsClient';

// Refresh the fleet snapshot this often (fixes drift in route ids / statuses; feeds the "stale" indicator).
export const FLEET_REFRESH_MS: number = 30_000;

export interface AppDependencies {
  fetch: FetchFn;
  createEventSource: EventSourceFactory;
  createWebSocket: WebSocketFactory;
  idStore: DispatcherIdStore;
  wsUrl: string;
}

// The part of the Zustand store startup needs (the real store, or the same store in tests).
export interface StoreAccess {
  getState: () => FleetState;
}

export interface RunningApp {
  // Used by UI actions (alerts) in later phases.
  rest: RestClient;
  // Create / update / reassign routes (Phase 5).
  routeActions: RouteActions;
  ws: WsClient;
  stop: () => void;
}

export function startApp(dispatcherName: string, deps: AppDependencies, store: StoreAccess): RunningApp {
  const rest = new RestClient({ fetch: deps.fetch });
  const breaker = new CircuitBreaker();
  let stopped = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let fleetLoadInFlight = false;
  let previousSseStatus: ConnectionStatus = 'idle';

  // Loads the fleet snapshot, then schedules the next load: at the end of the breaker cooldown when open
  // (that call is the probe), otherwise in 30 s. A call while one is in flight is skipped — the next refresh follows.
  async function loadFleet(): Promise<void> {
    if (stopped || fleetLoadInFlight) return;
    fleetLoadInFlight = true;
    clearRefreshTimer();
    const result = await withRetry(() => breaker.call(() => rest.getFleet()));
    fleetLoadInFlight = false;
    if (stopped) return;

    if (result.ok) {
      store.getState().applyFleetResponse(result.data);
    } else {
      // Keep showing the last data, marked stale (QUIRK #7 → circuit breaker / degraded mode).
      store.getState().setFleetStale(true);
    }
    scheduleNextFleetLoad();
  }

  function scheduleNextFleetLoad(): void {
    const openUntil = breaker.openUntil;
    const delay = openUntil !== null && breaker.state === 'open' ? openUntil - Date.now() : FLEET_REFRESH_MS;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void loadFleet();
    }, Math.max(delay, 0));
  }

  function clearRefreshTimer(): void {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  // Routes snapshot (on start and after a WS gap). Retried like any read; no breaker (that's for the fleet endpoint).
  async function loadRoutes(): Promise<void> {
    if (stopped) return;
    const result = await withRetry(() => rest.getRoutes());
    if (stopped || !result.ok) return;
    store.getState().applyRoutesResponse(result.data.routes);
  }

  const sse = new SseClient({
    createEventSource: deps.createEventSource,
    onEvent: (event) => store.getState().applySseEvent(event),
    onStatusChange: (status) => {
      store.getState().setSseStatus(status);
      // Back after a gap: telemetry can't be replayed (no event ids), so refresh the snapshot.
      if (status === 'open' && previousSseStatus === 'reconnecting') {
        void loadFleet();
      }
      previousSseStatus = status;
    },
  });

  function handleWsMessage(message: WsServerMessage): void {
    if (message.type === 'fleet_reset') {
      // The server re-created every truck and deleted all routes: drop local state and reload.
      store.getState().resetFleet();
      void loadFleet();
      void loadRoutes();
      return;
    }
    if (isRouteMessage(message)) {
      store.getState().applyRouteMessage(message);
    }
    // Presence messages are handled in Phase 6.
  }

  const ws = new WsClient({
    url: deps.wsUrl,
    name: dispatcherName,
    createWebSocket: deps.createWebSocket,
    idStore: deps.idStore,
    onMessage: handleWsMessage,
    onStatusChange: (status) => store.getState().setWsStatus(status),
    onRegistered: (dispatcherId) => {
      rest.setDispatcherId(dispatcherId);
      store.getState().setDispatcher(dispatcherId, dispatcherName);
      // First registration → initial load; a re-registration after a WS gap → refresh (we may have missed events).
      void loadFleet();
      void loadRoutes();
      // Idempotent: only the first call opens the stream.
      sse.connect();
    },
  });

  store.getState().setDispatcher(null, dispatcherName);
  ws.connect();

  return {
    rest,
    routeActions: createRouteActions(rest, store),
    ws,
    stop: () => {
      stopped = true;
      clearRefreshTimer();
      ws.close();
      sse.close();
    },
  };
}
