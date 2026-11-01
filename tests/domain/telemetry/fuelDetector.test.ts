// Feature: Fuel sensor glitch (QUIRK #2)
// Tests:   src/domain/telemetry/detectors/fuel.ts → fuelDetector.evaluate()
// Rule:    fuel can't change faster than profile.maxFuelChangePerSecond (either direction), measured from the
//          previous reading (gap capped). A sudden jump is 'unverified': show the last trusted value. If the value
//          returns near it → glitch. If the jump holds for FUEL_CONFIRM_WINDOW_MS → accept as real.
//          Out of 0..100 → sensor_fault. Never hide a real change.
import { describe, expect, it } from 'vitest';
import { TelemetryReadingSchema, type TelemetryReading } from '../../../src/domain/models';
import { FUEL_CONFIRM_WINDOW_MS } from '../../../src/domain/telemetry/config';
import { fuelDetector } from '../../../src/domain/telemetry/detectors/fuel';
import type { SensorState } from '../../../src/domain/telemetry/sensors';
import { VEHICLE_PROFILES } from '../../../src/domain/vehicles';
import fuelGlitchFixture from '../../../fixtures/sse/fuel_glitch_sequence.json';
import telemetryFixture from '../../../fixtures/sse/telemetry.json';

const TRUCK = VEHICLE_PROFILES.truck;
const START = 100_000;
const TICK_MS = 2000; // the server sends one reading per truck every 2 s

function makeReading(fuel: number, timestamp: number): TelemetryReading {
  const template = TelemetryReadingSchema.parse(telemetryFixture.readings[0]);
  return { ...template, fuel, timestamp };
}

// Feeds fuel values one per tick (2 s apart) and returns every resulting state.
function evaluateSeries(fuelValues: number[], startState?: SensorState): SensorState[] {
  const states: SensorState[] = [];
  let previous = startState;
  fuelValues.forEach((fuel, index) => {
    previous = fuelDetector.evaluate(previous, makeReading(fuel, START + index * TICK_MS), TRUCK);
    states.push(previous);
  });
  return states;
}

function lastOf(states: SensorState[]): SensorState {
  const last = states.at(-1);
  if (last === undefined) throw new Error('no states');
  return last;
}

describe('Fuel sensor — normal readings', () => {
  it('1. a normal reading is shown as-is', () => {
    const state = lastOf(evaluateSeries([73.6]));
    expect(state.value).toBe(73.6);
    expect(state.status).toBe('ok');
  });

  it('2. a gradual real decrease is shown and never becomes unverified', () => {
    const states = evaluateSeries([73.6, 73.58, 73.56, 73.54]);
    expect(states.every((state) => state.status === 'ok')).toBe(true);
    expect(lastOf(states).value).toBe(73.54);
  });

  it('3. a gradual real rise (refueling) is shown', () => {
    const states = evaluateSeries([20, 21, 22, 23]);
    expect(states.every((state) => state.status === 'ok')).toBe(true);
    expect(lastOf(states).value).toBe(23);
  });
});

describe('Fuel sensor — impossible values', () => {
  it('4. below 0 or above 100 is a sensor_fault immediately; the last trusted value is kept', () => {
    expect(lastOf(evaluateSeries([50, -5]))).toMatchObject({ value: 50, status: 'sensor_fault' });
    expect(lastOf(evaluateSeries([50, 120]))).toMatchObject({ value: 50, status: 'sensor_fault' });
  });
});

describe('Fuel sensor — sudden jumps', () => {
  it('5. a sudden drop shows the last trusted value, unverified', () => {
    const state = lastOf(evaluateSeries([73.6, 0]));
    expect(state).toMatchObject({ value: 73.6, status: 'unverified', since: START + TICK_MS });
  });

  it('6. a sudden rise (15 → 80) shows the last trusted value, unverified', () => {
    const state = lastOf(evaluateSeries([15, 80]));
    expect(state).toMatchObject({ value: 15, status: 'unverified' });
  });

  it('7. returning near the trusted value within the window → ok again, resolved as glitch', () => {
    const state = lastOf(evaluateSeries([73.6, 0, 0, 73.5]));
    expect(state).toMatchObject({ value: 73.5, status: 'ok', resolved: 'glitch' });
  });

  it('8. a jump that holds for the window is accepted as real', () => {
    const ticksToConfirm = FUEL_CONFIRM_WINDOW_MS / TICK_MS;
    const values = [73.6, ...Array<number>(ticksToConfirm + 1).fill(10)];
    const states = evaluateSeries(values);
    expect(lastOf(states)).toMatchObject({ value: 10, status: 'ok', resolved: 'confirmed' });
    // Before the window passed it was still unverified.
    expect(states[states.length - 2]?.status).toBe('unverified');
  });

  it('9. a value that keeps jumping is shown (latest) once the window passes — never "checking" forever', () => {
    // Jump starts at tick 1; tick 4 is 6 s later (= the window) → the latest value (10) is shown.
    const states = evaluateSeries([73.6, 0, 10, 0, 10]);
    expect(states.slice(1, 4).every((state) => state.status === 'unverified')).toBe(true);
    expect(lastOf(states)).toMatchObject({ value: 10, status: 'ok', resolved: 'confirmed' });
  });

  it('10. "near the trusted value" allows normal drift', () => {
    const state = lastOf(evaluateSeries([73.6, 0, 73.0]));
    expect(state).toMatchObject({ value: 73.0, status: 'ok', resolved: 'glitch' });
  });

  it('10b. review fix: the allowance does NOT grow while unverified — a held glitch is not accepted early', () => {
    // Old bug: at tick 2 the allowance (rate × 4 s) covered 15 → 0 and the glitch value was accepted as ok.
    const states = evaluateSeries([15, 0, 0, 0]);
    expect(states.slice(1).every((state) => state.status === 'unverified' && state.value === 15)).toBe(true);
  });

  it('10c. review fix: a low-fuel truck dropping to 0 is still caught (8 → 0)', () => {
    expect(lastOf(evaluateSeries([8, 0]))).toMatchObject({ value: 8, status: 'unverified' });
  });

  it('10d. review fix: an out-of-range reading mid-episode keeps the episode start (window not reset)', () => {
    // Episode starts at tick 1. Tick 2 is out of range. Tick 4 is 6 s after tick 1 → confirmed.
    const states = evaluateSeries([73.6, 0, 150, 0, 0]);
    expect(states[2]).toMatchObject({ status: 'sensor_fault', since: START + TICK_MS });
    expect(lastOf(states)).toMatchObject({ value: 0, status: 'ok', resolved: 'confirmed' });
  });
});

describe('Fuel sensor — time gaps', () => {
  it('11. after a long pause, a big change is not trusted blindly: unverified, then confirmed after the window', () => {
    const trusted = fuelDetector.evaluate(undefined, makeReading(20, START), TRUCK);
    const resumeAt = START + 10 * 60_000;
    const afterPause = fuelDetector.evaluate(trusted, makeReading(90, resumeAt), TRUCK);
    expect(afterPause).toMatchObject({ value: 20, status: 'unverified' });

    const held = fuelDetector.evaluate(afterPause, makeReading(90, resumeAt + FUEL_CONFIRM_WINDOW_MS), TRUCK);
    expect(held).toMatchObject({ value: 90, status: 'ok', resolved: 'confirmed' });
  });

  it('11b. review fix: a glitch right after a gap (e.g. reconnect) is still caught', () => {
    const trusted = fuelDetector.evaluate(undefined, makeReading(40, START), TRUCK);
    const glitch = fuelDetector.evaluate(trusted, makeReading(0, START + 30_000), TRUCK);
    expect(glitch).toMatchObject({ value: 40, status: 'unverified' });
  });
});

describe('Fuel sensor — first reading', () => {
  it('12. a normal first reading is shown', () => {
    expect(lastOf(evaluateSeries([45]))).toMatchObject({ value: 45, status: 'ok' });
  });

  it('13. a first reading of 0 is unverified with an unknown value until the window passes', () => {
    const ticksToConfirm = FUEL_CONFIRM_WINDOW_MS / TICK_MS;
    const states = evaluateSeries(Array<number>(ticksToConfirm + 1).fill(0));
    expect(states[0]).toMatchObject({ value: null, status: 'unverified' });
    expect(lastOf(states)).toMatchObject({ value: 0, status: 'ok', resolved: 'confirmed' });
  });

  it('13b. a first reading of 0 followed by a normal value resolves as glitch', () => {
    expect(lastOf(evaluateSeries([0, 73.6]))).toMatchObject({ value: 73.6, status: 'ok', resolved: 'glitch' });
  });
});

describe('Fuel sensor — real server data', () => {
  it('14. the captured glitch (73.6 → 0 → 0 → 73.5) never shows 0 and resolves as glitch', () => {
    const states: SensorState[] = [];
    let previous: SensorState | undefined = undefined;
    for (const entry of fuelGlitchFixture) {
      if (entry.type === 'telemetry' && 'reading' in entry) {
        previous = fuelDetector.evaluate(previous, TelemetryReadingSchema.parse(entry.reading), TRUCK);
        states.push(previous);
      }
    }
    expect(states.some((state) => state.value === 0)).toBe(false);
    expect(states.some((state) => state.status === 'unverified')).toBe(true);
    expect(states.some((state) => state.resolved === 'glitch')).toBe(true);
  });
});
