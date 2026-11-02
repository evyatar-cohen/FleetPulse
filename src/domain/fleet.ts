// Fleet state: every truck's info (from REST) plus its cleaned telemetry (Phase 2 pipeline), keyed by truck id.
// Data flow: store action → applyFleetSnapshot() / applyTelemetryEvent() → new Trucks → store saves it → UI.
// Pure functions: no I/O, no store, no React.
import type { SseEvent } from './events';
import type { FleetTruck, TelemetryReading, TruckStatus } from './models';
import { ingestBatch, ingestReading, type IngestContext, type TruckTelemetry } from './telemetry/truckTelemetry';
import { DEFAULT_VEHICLE_TYPE, getVehicleProfile } from './vehicles';

export interface TruckView {
  id: string;
  name: string;
  vehicleType: string;
  currentRouteId: string | null;
  // Status from the last REST snapshot; live status comes from telemetry (see truckStatus()).
  snapshotStatus: TruckStatus;
  // Phase 2 state: current reading, path, trusted sensor values. undefined until the first reading.
  telemetry: TruckTelemetry | undefined;
}

export type Trucks = Readonly<Record<string, TruckView>>;

// The live status: the newest accepted reading wins over the (older) REST snapshot.
export function truckStatus(truck: TruckView): TruckStatus {
  return truck.telemetry === undefined ? truck.snapshotStatus : truck.telemetry.current.status;
}

// The REST fleet carries the same sensor values as a telemetry reading — use it as a first reading, so trucks
// have a position before the first SSE tick (and even if SSE is down).
function snapshotToReading(truck: FleetTruck, fetchedAt: number): TelemetryReading {
  return {
    truckId: truck.id,
    location: truck.location,
    speed: truck.speed,
    heading: truck.heading,
    fuel: truck.fuel,
    engineTemp: truck.engineTemp,
    status: truck.status,
    timestamp: fetchedAt,
  };
}

// Applies GET /api/fleet. Trucks not in the snapshot are removed (the server's fleet is the source of truth).
// Existing telemetry is kept and the snapshot goes through the normal ordering rules, so an older snapshot never
// overwrites newer live data.
export function applyFleetSnapshot(trucks: Trucks, fleet: readonly FleetTruck[], fetchedAt: number): Trucks {
  const next: Record<string, TruckView> = {};
  for (const info of fleet) {
    const previous = trucks[info.id];
    const profile = getVehicleProfile(info.vehicleType);
    const reading = snapshotToReading(info, fetchedAt);
    const telemetry = ingestReading(previous?.telemetry, reading, { now: fetchedAt, profile }).state;
    next[info.id] = {
      id: info.id,
      name: info.name,
      vehicleType: info.vehicleType,
      currentRouteId: info.currentRouteId,
      snapshotStatus: info.status,
      telemetry,
    };
  }
  return next;
}

// A truck we only know from telemetry (SSE arrived before the snapshot, or the server added one).
function unknownTruck(truckId: string, status: TruckStatus): TruckView {
  return {
    id: truckId,
    name: truckId,
    vehicleType: DEFAULT_VEHICLE_TYPE,
    currentRouteId: null,
    snapshotStatus: status,
    telemetry: undefined,
  };
}

function withTelemetry(truck: TruckView, telemetry: TruckTelemetry | undefined): TruckView {
  if (telemetry === truck.telemetry) return truck;
  return { ...truck, telemetry };
}

// Applies one SSE event. `serverTime` = the latest server timestamp seen (gps_batch events carry none).
// Returns the SAME object when nothing changed, so the UI doesn't redraw for nothing.
export function applyTelemetryEvent(trucks: Trucks, event: SseEvent, serverTime: number): Trucks {
  if (event.type === 'telemetry') {
    let next: Trucks = trucks;
    for (const reading of event.readings) {
      next = updateTelemetry(next, reading.truckId, reading.status, event.timestamp, (telemetry, context) =>
        ingestReading(telemetry, reading, context).state,
      );
    }
    return next;
  }
  if (event.type === 'gps_batch') {
    // QUIRK #1: buffered old readings for one truck — they fill the path, never move the marker.
    const first = event.readings[0];
    if (first === undefined) return trucks;
    return updateTelemetry(trucks, event.truckId, first.status, serverTime, (telemetry, context) =>
      ingestBatch(telemetry, event.readings, context),
    );
  }
  // connected / heartbeat: no truck data.
  return trucks;
}

// Runs one telemetry update for one truck and returns new Trucks (or the SAME object if nothing changed).
function updateTelemetry(
  trucks: Trucks,
  truckId: string,
  statusIfNew: TruckStatus,
  now: number,
  update: (telemetry: TruckTelemetry | undefined, context: IngestContext) => TruckTelemetry | undefined,
): Trucks {
  const truck = trucks[truckId] ?? unknownTruck(truckId, statusIfNew);
  const profile = getVehicleProfile(truck.vehicleType);
  const updated = withTelemetry(truck, update(truck.telemetry, { now, profile }));
  if (updated === trucks[truckId]) return trucks;
  return { ...trucks, [truckId]: updated };
}
