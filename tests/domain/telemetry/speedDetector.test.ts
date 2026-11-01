// Feature: Stuck / impossible speed sensor (QUIRK #3)
// Tests:   src/domain/telemetry/detectors/speed.ts → speedDetector.evaluate()
// Rule:    a speed outside 0..profile.maxSpeedKmh is physically impossible → show the last valid speed
//          (or "unknown" if none) and flag 'sensor_fault'. Generic — no truck id, no hardcoded 999.
import { describe, expect, it } from 'vitest';
import { TelemetryReadingSchema, type TelemetryReading } from '../../../src/domain/models';
import { speedDetector } from '../../../src/domain/telemetry/detectors/speed';
import type { SensorState } from '../../../src/domain/telemetry/sensors';
import { VEHICLE_PROFILES, type VehicleProfile } from '../../../src/domain/vehicles';
import speedStuckFixture from '../../../fixtures/sse/speed_stuck_sequence.json';
import telemetryFixture from '../../../fixtures/sse/telemetry.json';

const TRUCK: VehicleProfile = VEHICLE_PROFILES.truck;

function makeReading(overrides: Partial<TelemetryReading>): TelemetryReading {
  const reading = TelemetryReadingSchema.parse(telemetryFixture.readings[0]);
  return { ...reading, ...overrides };
}

// Runs readings through the detector in order and returns every intermediate state.
function evaluateAll(readings: TelemetryReading[], profile: VehicleProfile): SensorState[] {
  const states: SensorState[] = [];
  let previous: SensorState | undefined = undefined;
  for (const reading of readings) {
    previous = speedDetector.evaluate(previous, reading, profile);
    states.push(previous);
  }
  return states;
}

describe('Speed sensor (QUIRK #3)', () => {
  it('a normal speed is shown as-is', () => {
    const state = speedDetector.evaluate(undefined, makeReading({ speed: 42 }), TRUCK);
    expect(state).toEqual({ value: 42, status: 'ok' });
  });

  it('an impossible speed shows the last valid speed, flagged sensor_fault', () => {
    const states = evaluateAll(
      [makeReading({ speed: 42, timestamp: 1000 }), makeReading({ speed: 999, timestamp: 3000 })],
      TRUCK,
    );
    expect(states[1]).toEqual({ value: 42, status: 'sensor_fault', since: 3000 });
  });

  it('an impossible FIRST reading shows "unknown" (null), flagged', () => {
    const state = speedDetector.evaluate(undefined, makeReading({ speed: 999, timestamp: 1000 }), TRUCK);
    expect(state).toEqual({ value: null, status: 'sensor_fault', since: 1000 });
  });

  it('the flag clears when a valid speed returns', () => {
    const states = evaluateAll(
      [makeReading({ speed: 999, timestamp: 1000 }), makeReading({ speed: 30, timestamp: 3000 })],
      TRUCK,
    );
    expect(states[1]).toEqual({ value: 30, status: 'ok' });
  });

  it('during a long fault, `since` stays at the start of the episode', () => {
    const states = evaluateAll(
      [
        makeReading({ speed: 50, timestamp: 1000 }),
        makeReading({ speed: 999, timestamp: 3000 }),
        makeReading({ speed: 999, timestamp: 5000 }),
        makeReading({ speed: 999, timestamp: 7000 }),
      ],
      TRUCK,
    );
    expect(states[3]).toEqual({ value: 50, status: 'sensor_fault', since: 3000 });
  });

  it('boundaries: max is valid, just above max is not, negative is not', () => {
    const max = TRUCK.maxSpeedKmh;
    expect(speedDetector.evaluate(undefined, makeReading({ speed: max }), TRUCK).status).toBe('ok');
    expect(speedDetector.evaluate(undefined, makeReading({ speed: max + 0.1 }), TRUCK).status).toBe('sensor_fault');
    expect(speedDetector.evaluate(undefined, makeReading({ speed: -1 }), TRUCK).status).toBe('sensor_fault');
  });

  it('the limit comes from the vehicle profile: 180 km/h is a fault for a truck, fine for a faster type', () => {
    const fasterType: VehicleProfile = { ...TRUCK, maxSpeedKmh: 220 };
    const reading = makeReading({ speed: 180 });
    expect(speedDetector.evaluate(undefined, reading, TRUCK).status).toBe('sensor_fault');
    expect(speedDetector.evaluate(undefined, reading, fasterType).status).toBe('ok');
  });

  it('real server data: the stuck truck never shows an impossible speed; real 0 between episodes is shown', () => {
    const readings: TelemetryReading[] = [];
    for (const entry of speedStuckFixture) {
      if (entry.type === 'telemetry' && 'reading' in entry) {
        readings.push(TelemetryReadingSchema.parse(entry.reading));
      }
    }
    const states = evaluateAll(readings, TRUCK);

    for (const state of states) {
      if (state.value !== null) {
        expect(state.value).toBeLessThanOrEqual(TRUCK.maxSpeedKmh);
      }
    }
    // The fixture contains real 0-speed readings (truck in maintenance) between 999 episodes.
    const shownZero = states.some((state) => state.status === 'ok' && state.value === 0);
    expect(shownZero).toBe(true);
  });
});
