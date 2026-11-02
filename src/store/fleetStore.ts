// The single app store (Zustand): trucks, connection status, data freshness, and who we are.
// Data flow: transport callbacks → store actions (thin: call a pure domain function, save the result) → React
// components read slices with selectors and redraw only when their slice changes.
import { create } from 'zustand';
import type { SseEvent } from '../domain/events';
import { applyFleetSnapshot, applyTelemetryEvent, type Trucks } from '../domain/fleet';
import type { FleetResponse } from '../domain/api';
import type { ConnectionStatus } from '../transport/connection';

export interface FleetState {
  trucks: Trucks;
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
  setFleetStale: (stale: boolean) => void;
  setSseStatus: (status: ConnectionStatus) => void;
  setWsStatus: (status: ConnectionStatus) => void;
  setDispatcher: (id: string | null, name: string) => void;
  resetFleet: () => void;
}

const INITIAL_DATA = {
  trucks: {},
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

  setFleetStale: (stale) => set({ fleetStale: stale }),
  setSseStatus: (status) => set({ sseStatus: status }),
  setWsStatus: (status) => set({ wsStatus: status }),
  setDispatcher: (id, name) => set({ dispatcherId: id, dispatcherName: name }),

  // fleet_reset (WS): the server re-created all trucks — drop local truck data; the snapshot is reloaded next.
  resetFleet: () => set({ trucks: {}, serverTime: null, fleetFetchedAt: null }),
}));
