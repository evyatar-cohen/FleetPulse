// Composition root: the one place that creates the transport clients and wires them to the store.
// Startup order: create our dispatcher id (carries our name) → WS connect → register → `registered` (our id → REST
// client) → load fleet + routes → SSE connect.
// Then: fleet refresh every 30 s (retry + circuit breaker → "stale" flag), reload on `fleet_reset` and after an
// SSE reconnect (missed data can't be replayed). stop() cleans up everything.
import { makeDispatcherId, nameFromDispatcherId } from '../domain/dispatcherIdentity';
import type { WsServerMessage } from '../domain/events';
import { isPresenceMessage } from '../domain/presence';
import { isRouteMessage } from '../domain/routes';
import { createRouteActions, type RouteActions } from './routeActions';
import { createTruckActions, type TruckActions } from './truckActions';
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
  rest: RestClient;
  // Create / update / reassign routes (Phase 5).
  routeActions: RouteActions;
  // Detail panel: truck detail (mileage) and sending alerts (Phase 7).
  truckActions: TruckActions;
  // Select a truck (detail panel) and tell other dispatchers we're viewing it (presence). null = deselect.
  selectTruck: (truckId: string | null) => void;
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
    } else if (isPresenceMessage(message)) {
      // QUIRK #6: ghost-safe presence (connection counting) — see domain/presence.ts.
      store.getState().applyPresenceMessage(message);
      // A newcomer gets no list of who's online — announce ourselves so they can see us.
      if (message.type === 'dispatcher_joined' && message.dispatcherId !== ws.id) {
        ws.announcePresence();
      }
    } else if (message.type === 'truck_alert') {
      store.getState().applyAlert(message.alert);
    }
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

  // We choose our own id (the server accepts it) so it carries our name — see domain/dispatcherIdentity.ts.
  // A saved id is kept (same identity after a reload) unless it doesn't carry the current name.
  const savedId = deps.idStore.load();
  if (savedId === null || nameFromDispatcherId(savedId) !== dispatcherName) {
    deps.idStore.save(makeDispatcherId(dispatcherName, crypto.randomUUID().slice(0, 8)));
  }

  store.getState().setDispatcher(null, dispatcherName);
  ws.connect();

  return {
    rest,
    routeActions: createRouteActions(rest, store),
    truckActions: createTruckActions(rest),
    selectTruck: (truckId) => {
      store.getState().selectTruck(truckId);
      // null (panel closed) is sent as "not viewing" so our viewer tag disappears for the others.
      ws.setViewingTruck(truckId);
    },
    ws,
    stop: () => {
      stopped = true;
      clearRefreshTimer();
      ws.close();
      sse.close();
    },
  };
}
