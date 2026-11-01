// Fuel detector — QUIRK #2: the sensor reads 0% for a few seconds (hard braking), then recovers.
// Generic rule: fuel can't change faster than profile.maxFuelChangePerSecond in either direction. A faster jump
// is 'unverified' — we keep showing the last trusted value. Then:
//   back near the trusted value → it was a glitch ('glitch')
//   still off after FUEL_CONFIRM_WINDOW_MS → accept it as real ('confirmed') — a real problem is never hidden
// Values outside 0..100 are impossible → 'sensor_fault' right away.
import type { TelemetryReading } from '../../models';
import type { VehicleProfile } from '../../vehicles';
import { FUEL_CONFIRM_WINDOW_MS } from '../config';
import type { SensorDetector, SensorResolution, SensorState, SensorStatus } from '../sensors';

const MIN_FUEL = 0;
const MAX_FUEL = 100;

function isInRange(fuel: number): boolean {
  return fuel >= MIN_FUEL && fuel <= MAX_FUEL;
}

// Allowed change grows with the time since the trusted value — so after a long stream pause a big change is fine.
function isPlausibleChange(trustedValue: number, trustedAt: number, reading: TelemetryReading, profile: VehicleProfile): boolean {
  const elapsedSeconds = (reading.timestamp - trustedAt) / 1000;
  const allowedChange = profile.maxFuelChangePerSecond * elapsedSeconds;
  return Math.abs(reading.fuel - trustedValue) <= allowedChange;
}

function hasWindowPassed(previous: SensorState | undefined, now: number): boolean {
  if (previous === undefined || previous.status !== 'unverified' || previous.since === undefined) {
    return false;
  }
  return now - previous.since >= FUEL_CONFIRM_WINDOW_MS;
}

// The reading becomes the new trusted value.
function accept(reading: TelemetryReading, resolved: SensorResolution | undefined): SensorState {
  const state: SensorState = { value: reading.fuel, status: 'ok', valueAt: reading.timestamp };
  if (resolved !== undefined) {
    state.resolved = resolved;
  }
  return state;
}

// Keep showing the last trusted value, with a non-ok status. The episode start (`since`) is kept while the
// status stays the same.
function keepTrusted(previous: SensorState | undefined, status: SensorStatus, now: number): SensorState {
  const continuesEpisode = previous !== undefined && previous.status === status && previous.since !== undefined;
  const state: SensorState = {
    value: previous === undefined ? null : previous.value,
    status,
    since: continuesEpisode ? previous.since : now,
  };
  if (previous !== undefined && previous.valueAt !== undefined) {
    state.valueAt = previous.valueAt;
  }
  return state;
}

function resolutionAfter(previous: SensorState | undefined): SensorResolution | undefined {
  return previous !== undefined && previous.status === 'unverified' ? 'glitch' : undefined;
}

// No trusted value yet (first reading, or only bad readings so far): nothing to compare against.
// A 0 is the typical sensor dropout value, so it waits for the window; anything else is accepted.
function evaluateWithoutTrustedValue(previous: SensorState | undefined, reading: TelemetryReading): SensorState {
  if (reading.fuel !== 0) {
    return accept(reading, resolutionAfter(previous));
  }
  if (hasWindowPassed(previous, reading.timestamp)) {
    return accept(reading, 'confirmed');
  }
  return keepTrusted(previous, 'unverified', reading.timestamp);
}

export const fuelDetector: SensorDetector = {
  id: 'fuel',
  evaluate(previous: SensorState | undefined, reading: TelemetryReading, profile: VehicleProfile): SensorState {
    if (!isInRange(reading.fuel)) {
      return keepTrusted(previous, 'sensor_fault', reading.timestamp);
    }
    if (previous === undefined || previous.value === null || previous.valueAt === undefined) {
      return evaluateWithoutTrustedValue(previous, reading);
    }
    if (isPlausibleChange(previous.value, previous.valueAt, reading, profile)) {
      return accept(reading, resolutionAfter(previous));
    }
    if (hasWindowPassed(previous, reading.timestamp)) {
      return accept(reading, 'confirmed');
    }
    return keepTrusted(previous, 'unverified', reading.timestamp);
  },
};
