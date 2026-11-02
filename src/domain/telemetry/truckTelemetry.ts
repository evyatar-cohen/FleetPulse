// Per-truck telemetry state and the rules for accepting new readings.
// Data flow: transport parses an SSE event → store calls ingestReading() / ingestBatch() → store keeps the
// returned state. Pure functions: no I/O, no clock — "now" and the vehicle profile are passed in by the caller.
import type { TelemetryReading } from '../models';
import type { VehicleProfile } from '../vehicles';
import { MAX_FUTURE_SKEW_MS, MAX_HISTORY_SAMPLES } from './config';
import { addToPath, isPlausiblePathPoint, type PathPoint } from './path';
import { evaluateSensors, type SensorStates } from './sensors';

export interface TruckTelemetry {
  // The newest accepted raw reading — drives the map marker. Its timestamp is the reference for ordering.
  current: TelemetryReading;
  // Every known position (current + late + batch), sorted by timestamp — drives the drawn route.
  path: readonly PathPoint[];
  // Trusted sensor values + status per detector ('speed', …) — what the dispatcher sees instead of raw values.
  sensors: SensorStates;
  // Recent TRUSTED values for the detail charts (never 999 km/h or a glitch 0%), oldest first, bounded.
  history: readonly SensorSample[];
}

export interface SensorSample {
  timestamp: number;
  // null = no trusted value at that moment.
  speed: number | null;
  fuel: number | null;
  // No detector for engine temperature yet — the reading's value.
  engineTemp: number;
}

function appendSample(history: readonly SensorSample[], sample: SensorSample): readonly SensorSample[] {
  const next = [...history, sample];
  return next.length > MAX_HISTORY_SAMPLES ? next.slice(next.length - MAX_HISTORY_SAMPLES) : next;
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
    const sensors = evaluateSensors(previousSensors, reading, context.profile);
    const sample: SensorSample = {
      timestamp: reading.timestamp,
      speed: sensors['speed']?.value ?? null,
      fuel: sensors['fuel']?.value ?? null,
      engineTemp: reading.engineTemp,
    };
    return {
      state: {
        current: reading,
        path: addToPath(previousPath, toPathPoint(reading)),
        sensors,
        history: appendSample(state === undefined ? [] : state.history, sample),
      },
      outcome,
    };
  }

  // A late reading can't move the marker or change sensors, but it still tells us where the truck was.
  if (outcome === 'stale') {
    return { state: addHistoryPoint(state, reading, context), outcome };
  }

  return { state, outcome };
}

// Adds a reading's position to the path WITHOUT moving the marker or touching sensors — only if it is physically
// reachable from its time-neighbors (see isPlausiblePathPoint) and not from the future. Same object if unchanged.
function addHistoryPoint(
  state: TruckTelemetry | undefined,
  reading: TelemetryReading,
  context: IngestContext,
): TruckTelemetry | undefined {
  if (state === undefined || reading.timestamp > context.now + MAX_FUTURE_SKEW_MS) {
    return state;
  }
  const point = toPathPoint(reading);
  if (!isPlausiblePathPoint(state.path, point, context.profile.maxSpeedKmh)) {
    return state;
  }
  const path = addToPath(state.path, point);
  if (path === state.path) {
    return state;
  }
  return { ...state, path };
}

function newestOf(readings: readonly TelemetryReading[]): TelemetryReading | undefined {
  let newest: TelemetryReading | undefined;
  for (const reading of readings) {
    if (newest === undefined || reading.timestamp > newest.timestamp) {
      newest = reading;
    }
  }
  return newest;
}

// QUIRK #1: a GPS batch is buffered HISTORY (readings stored while the truck had no signal). It fills the path but
// never moves the marker — its newest reading can be a few ms "newer" than the last live one and is just as noisy.
// Exception: a truck with no position yet takes the batch's newest reading as its current one.
export function ingestBatch(
  state: TruckTelemetry | undefined,
  readings: readonly TelemetryReading[],
  context: IngestContext,
): TruckTelemetry | undefined {
  let result = state;
  if (result === undefined) {
    const newest = newestOf(readings);
    if (newest === undefined) return result;
    result = ingestReading(undefined, newest, context).state;
  }
  for (const reading of readings) {
    result = addHistoryPoint(result, reading, context);
  }
  return result;
}
