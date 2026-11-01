// Per-truck telemetry state and the rules for accepting new readings.
// Data flow: transport parses an SSE event → store calls ingestReading() / ingestBatch() → store keeps the
// returned state. Pure functions: no I/O, no clock — "now" and the vehicle profile are passed in by the caller.
import type { TelemetryReading } from '../models';
import type { VehicleProfile } from '../vehicles';
import { MAX_FUTURE_SKEW_MS } from './config';
import { addToPath, type PathPoint } from './path';
import { evaluateSensors, type SensorStates } from './sensors';

export interface TruckTelemetry {
  // The newest accepted raw reading — drives the map marker. Its timestamp is the reference for ordering.
  current: TelemetryReading;
  // Every known position (current + late + batch), sorted by timestamp — drives the drawn route.
  path: readonly PathPoint[];
  // Trusted sensor values + status per detector ('speed', …) — what the dispatcher sees instead of raw values.
  sensors: SensorStates;
}

export interface IngestContext {
  // Server send time of the event that carried the reading (event.timestamp).
  now: number;
  // Limits for this truck's vehicle type.
  profile: VehicleProfile;
}

// Why a reading was accepted or ignored.
export type IngestOutcome = 'accepted' | 'stale' | 'duplicate' | 'future';

export interface IngestResult {
  // Unchanged object when nothing changed; a new object otherwise.
  state: TruckTelemetry | undefined;
  outcome: IngestOutcome;
}

export function classifyReading(
  state: TruckTelemetry | undefined,
  reading: TelemetryReading,
  now: number,
): IngestOutcome {
  // Clock-bug guard: checked first, so a future reading can never become the ordering reference.
  if (reading.timestamp > now + MAX_FUTURE_SKEW_MS) {
    return 'future';
  }
  if (state === undefined) {
    return 'accepted';
  }
  // QUIRK #5: order by measurement time, not arrival time.
  if (reading.timestamp > state.current.timestamp) {
    return 'accepted';
  }
  if (reading.timestamp === state.current.timestamp) {
    return 'duplicate';
  }
  return 'stale';
}

function toPathPoint(reading: TelemetryReading): PathPoint {
  return { lat: reading.location.lat, lng: reading.location.lng, timestamp: reading.timestamp };
}

export function ingestReading(
  state: TruckTelemetry | undefined,
  reading: TelemetryReading,
  context: IngestContext,
): IngestResult {
  const outcome = classifyReading(state, reading, context.now);

  if (outcome === 'accepted') {
    const previousPath = state === undefined ? [] : state.path;
    const previousSensors = state === undefined ? undefined : state.sensors;
    return {
      state: {
        current: reading,
        path: addToPath(previousPath, toPathPoint(reading)),
        sensors: evaluateSensors(previousSensors, reading, context.profile),
      },
      outcome,
    };
  }

  // A late reading can't move the marker or change sensors, but it still tells us where the truck was.
  if (outcome === 'stale' && state !== undefined) {
    const path = addToPath(state.path, toPathPoint(reading));
    if (path === state.path) {
      return { state, outcome };
    }
    return { state: { ...state, path }, outcome };
  }

  return { state, outcome };
}

// QUIRK #1: a GPS batch is just many readings — the same rules apply to each one.
export function ingestBatch(
  state: TruckTelemetry | undefined,
  readings: readonly TelemetryReading[],
  context: IngestContext,
): TruckTelemetry | undefined {
  let result = state;
  for (const reading of readings) {
    result = ingestReading(result, reading, context).state;
  }
  return result;
}
