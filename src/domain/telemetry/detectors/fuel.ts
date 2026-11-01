// Fuel detector — QUIRK #2: the sensor reads 0% for a few seconds (hard braking), then recovers.
// Generic rule: fuel can't change faster than profile.maxFuelChangePerSecond in either direction, measured from
// the PREVIOUS reading. A faster jump is 'unverified' — we keep showing the last trusted value. Then:
//   back near the trusted value → it was a glitch ('glitch')
//   still off after FUEL_CONFIRM_WINDOW_MS → accept it as real ('confirmed') — a real problem is never hidden
// Values outside 0..100 are impossible → 'sensor_fault' right away.
import type { TelemetryReading } from '../../models';
import type { VehicleProfile } from '../../vehicles';
import { FUEL_CONFIRM_WINDOW_MS, FUEL_MAX_RATE_GAP_MS } from '../config';
import {
  keepTrusted,
  type SensorDetector,
  type SensorResolution,
  type SensorState,
  type SensorStatus,
} from '../sensors';

const MIN_FUEL = 0;
const MAX_FUEL = 100;

function isInRange(fuel: number): boolean {
  return fuel >= MIN_FUEL && fuel <= MAX_FUEL;
}

// The allowance is measured from the previous reading (not from the trusted one), so it does NOT grow while a
// glitch lasts. The gap is capped: after a long pause we can't judge a big change, so it waits for the window.
function isPlausibleChange(
  trustedValue: number,
  previousReadingAt: number,
  reading: TelemetryReading,
  profile: VehicleProfile,
): boolean {
  const gapMs = Math.min(reading.timestamp - previousReadingAt, FUEL_MAX_RATE_GAP_MS);
  const allowedChange = profile.maxFuelChangePerSecond * (gapMs / 1000);
  return Math.abs(reading.fuel - trustedValue) <= allowedChange;
}

function hasWindowPassed(previous: SensorState | undefined, now: number): boolean {
  if (previous === undefined || previous.status === 'ok' || previous.since === undefined) {
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

// Not trusted: keep the trusted value, but remember when we saw this reading (the next rate check starts here).
function reject(previous: SensorState | undefined, status: SensorStatus, reading: TelemetryReading): SensorState {
  return { ...keepTrusted(previous, status, reading.timestamp), lastReadingAt: reading.timestamp };
}

function resolutionAfter(previous: SensorState | undefined): SensorResolution | undefined {
  return previous !== undefined && previous.status !== 'ok' ? 'glitch' : undefined;
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
  return reject(previous, 'unverified', reading);
}

export const fuelDetector: SensorDetector = {
  id: 'fuel',
  evaluate(previous: SensorState | undefined, reading: TelemetryReading, profile: VehicleProfile): SensorState {
    if (!isInRange(reading.fuel)) {
      return reject(previous, 'sensor_fault', reading);
    }
    if (previous === undefined || previous.value === null || previous.valueAt === undefined) {
      return evaluateWithoutTrustedValue(previous, reading);
    }
    const previousReadingAt = previous.lastReadingAt ?? previous.valueAt;
    if (isPlausibleChange(previous.value, previousReadingAt, reading, profile)) {
      return accept(reading, resolutionAfter(previous));
    }
    if (hasWindowPassed(previous, reading.timestamp)) {
      return accept(reading, 'confirmed');
    }
    return reject(previous, 'unverified', reading);
  },
};
