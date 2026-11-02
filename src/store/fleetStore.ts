// The single app store (Zustand): trucks, routes, audit log, presence, alerts, connection status, data freshness,
// selection and who we are.
// Data flow: transport callbacks → store actions (thin: call a pure domain function, save the result) → React
// components read slices with selectors and redraw only when their slice changes.
import { create } from 'zustand';
import type { SseEvent } from '../domain/events';
import { applyFleetSnapshot, applyRouteMessageToTrucks, applyTelemetryEvent, type Trucks } from '../domain/fleet';
import type { Alert, Route } from '../domain/models';
import { addAlert } from '../domain/alerts';
import { applyPresenceMessage, rememberName, type Presence, type PresenceMessage } from '../domain/presence';
import { applyRouteMessage, applyRoutesSnapshot, type RouteMessage, type Routes } from '../domain/routes';
import {
  addAuditEntries,
  auditEntriesFromSnapshot,
  auditEntryFromMessage,
  type AuditLog,
} from '../domain/auditLog';
import type { FleetResponse } from '../domain/api';
import type { ConnectionStatus } from '../transport/connection';

export interface FleetState {
  trucks: Trucks;
  routes: Routes;
  // Route change history (newest last), built client-side — the server has no audit endpoint.
  auditLog: AuditLog;
  // Other dispatchers online (ghost-safe, QUIRK #6) and every name we've seen (kept after they leave).
  presence: Presence;
  dispatcherNames: Readonly<Record<string, string>>;
  // Alerts sent to trucks by any dispatcher (newest last, bounded).
  alerts: readonly Alert[];
  // The truck this dispatcher selected (detail panel; announced to others via viewing_truck).
  selectedTruckId: string | null;
  // Latest server timestamp seen on SSE (gps_batch events have none of their own).
  serverTime: number | null;
  // When the fleet snapshot was last loaded successfully, and whether it is stale (circuit breaker open / failing).
  fleetFetchedAt: number | null;
  fleetStale: boolean;
  sseStatus: ConnectionStatus;
  wsStatus: ConnectionStatus;
  dispatcherId: string | null;
  dispatcherName: string;

  applyFleetResponse: (response: FleetResponse) => void;
  applySseEvent: (event: SseEvent) => void;
  applyRoutesResponse: (routes: readonly Route[]) => void;
  applyPresenceMessage: (message: PresenceMessage) => void;
  applyAlert: (alert: Alert) => void;
  selectTruck: (truckId: string | null) => void;
  applyRouteMessage: (message: RouteMessage) => void;
  setFleetStale: (stale: boolean) => void;
  setSseStatus: (status: ConnectionStatus) => void;
  setWsStatus: (status: ConnectionStatus) => void;
  setDispatcher: (id: string | null, name: string) => void;
  resetFleet: () => void;
}

const INITIAL_DATA = {
  trucks: {},
  routes: {},
  auditLog: [],
  presence: {},
  dispatcherNames: {},
  alerts: [],
  selectedTruckId: null,
  serverTime: null,
  fleetFetchedAt: null,
  fleetStale: false,
  sseStatus: 'idle',
  wsStatus: 'idle',
  dispatcherId: null,
  dispatcherName: '',
} as const satisfies Partial<FleetState>;

export const useFleetStore = create<FleetState>()((set, get) => ({
  ...INITIAL_DATA,

  applyFleetResponse: (response) =>
    set({
      trucks: applyFleetSnapshot(get().trucks, response.fleet, response.timestamp),
      fleetFetchedAt: response.timestamp,
      fleetStale: false,
    }),

  applySseEvent: (event) => {
    const state = get();
    const serverTime = 'timestamp' in event ? event.timestamp : state.serverTime;
    // A batch before any timestamped SSE event (rare: `connected` always comes first): fall back to the browser clock.
    const now = serverTime ?? Date.now();
    const trucks = applyTelemetryEvent(state.trucks, event, now);
    if (trucks !== state.trucks || serverTime !== state.serverTime) {
      set({ trucks, serverTime });
    }
  },

  applyRoutesResponse: (routes) => {
    const state = get();
    set({
      routes: applyRoutesSnapshot(state.routes, routes),
      auditLog: addAuditEntries(state.auditLog, auditEntriesFromSnapshot(routes)),
    });
  },

  // One action updates the route AND the trucks it affects, so the UI never sees them disagree.
  applyRouteMessage: (message) => {
    const state = get();
    const routes = applyRouteMessage(state.routes, message);
    if (routes === state.routes) return; // old or duplicate event — nothing changes
    const entry = auditEntryFromMessage(state.routes[message.route.id], message);
    set({
      routes,
      trucks: applyRouteMessageToTrucks(state.trucks, message),
      auditLog: addAuditEntries(state.auditLog, [entry]),
    });
  },

  applyPresenceMessage: (message) => {
    const state = get();
    const presence = applyPresenceMessage(state.presence, message, state.dispatcherId);
    const dispatcherNames = rememberName(state.dispatcherNames, message);
    if (presence !== state.presence || dispatcherNames !== state.dispatcherNames) {
      set({ presence, dispatcherNames });
    }
  },

  applyAlert: (alert) => {
    const alerts = addAlert(get().alerts, alert);
    if (alerts !== get().alerts) set({ alerts });
  },

  selectTruck: (truckId) => set({ selectedTruckId: truckId }),

  setFleetStale: (stale) => set({ fleetStale: stale }),
  setSseStatus: (status) => set({ sseStatus: status }),
  setWsStatus: (status) => set({ wsStatus: status }),
  setDispatcher: (id, name) => {
    const names = get().dispatcherNames;
    const dispatcherNames = id === null || names[id] === name ? names : { ...names, [id]: name };
    set({ dispatcherId: id, dispatcherName: name, dispatcherNames });
  },

  // fleet_reset (WS): the server re-created all trucks and deleted all routes — drop local data; snapshots reload next.
  resetFleet: () => set({ trucks: {}, routes: {}, auditLog: [], serverTime: null, fleetFetchedAt: null }),
}));
