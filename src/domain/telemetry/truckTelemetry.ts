// Per-truck telemetry state and the rules for accepting new readings.
// Data flow: transport parses an SSE event → store calls ingestReading() / ingestBatch() → store keeps the
// returned state. Pure functions: no I/O, no clock — "now" is passed in by the caller.
import type { TelemetryReading } from '../models';
import { MAX_FUTURE_SKEW_MS } from './config';
import { addToPath, type PathPoint } from './path';

export interface TruckTelemetry {
  // The newest accepted reading — drives the map marker. Its timestamp is the reference for ordering.
  current: TelemetryReading;
  // Every known position (current + late + batch), sorted by timestamp — drives the drawn route.
  path: readonly PathPoint[];
}

// Why a reading was accepted or ignored.
export type IngestOutcome = 'accepted' | 'stale' | 'duplicate' | 'future';

export interface IngestResult {
  // Unchanged object when nothing changed; a new object otherwise.
  state: TruckTelemetry | undefined;
  outcome: IngestOutcome;
}

// `now` = server send time of the event that carried this reading (event.timestamp).
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
  now: number,
): IngestResult {
  const outcome = classifyReading(state, reading, now);

  if (outcome === 'accepted') {
    const previousPath = state === undefined ? [] : state.path;
    return { state: { current: reading, path: addToPath(previousPath, toPathPoint(reading)) }, outcome };
  }

  // A late reading can't move the marker, but it still tells us where the truck was.
  if (outcome === 'stale' && state !== undefined) {
    const path = addToPath(state.path, toPathPoint(reading));
    if (path === state.path) {
      return { state, outcome };
    }
    return { state: { current: state.current, path }, outcome };
  }

  return { state, outcome };
}

// QUIRK #1: a GPS batch is just many readings — the same rules apply to each one.
export function ingestBatch(
  state: TruckTelemetry | undefined,
  readings: readonly TelemetryReading[],
  now: number,
): TruckTelemetry | undefined {
  let result = state;
  for (const reading of readings) {
    result = ingestReading(result, reading, now).state;
  }
  return result;
}
