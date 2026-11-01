// Sensor detectors: the shared shape every sensor check follows, and the runner that applies them all.
// Data flow: truckTelemetry.ingestReading() → evaluateSensors() for each ACCEPTED reading → per-sensor state
// (trusted value + status) that the UI displays.
// To add a sensor check: write a SensorDetector module and add it to SENSOR_DETECTORS (detectors/index.ts).
import type { TelemetryReading } from '../models';
import type { VehicleProfile } from '../vehicles';
import { SENSOR_DETECTORS } from './detectors';

// ok           — value is the latest reading
// sensor_fault — the reading is impossible; value is the last trusted one
// unverified   — the reading jumped suspiciously; value is the last trusted one while we wait to decide
export type SensorStatus = 'ok' | 'sensor_fault' | 'unverified';

// How an 'unverified' episode ended — set only on the reading that ends it. Feeds the anomaly log later.
export type SensorResolution = 'glitch' | 'confirmed';

export interface SensorState {
  // The value safe to show the dispatcher. null = unknown (no trustworthy value yet).
  value: number | null;
  status: SensorStatus;
  // Timestamp of the reading that produced `value` (needed for rate-of-change checks).
  valueAt?: number;
  // When the current non-ok status started (start of the episode). Absent when ok.
  since?: number;
  resolved?: SensorResolution;
}

// Sensor states of one truck, keyed by detector id ('speed', 'fuel', …).
export type SensorStates = Readonly<Record<string, SensorState>>;

export interface SensorDetector {
  id: string;
  evaluate(previous: SensorState | undefined, reading: TelemetryReading, profile: VehicleProfile): SensorState;
}

export function evaluateSensors(
  previous: SensorStates | undefined,
  reading: TelemetryReading,
  profile: VehicleProfile,
  detectors: readonly SensorDetector[] = SENSOR_DETECTORS,
): SensorStates {
  const result: Record<string, SensorState> = {};
  for (const detector of detectors) {
    const previousState = previous === undefined ? undefined : previous[detector.id];
    result[detector.id] = detector.evaluate(previousState, reading, profile);
  }
  return result;
}
