// Feature: Low-fuel alert — real low fuel vs. glitch (QUIRK #2: "don't trigger false low-fuel alerts")
// Tests:   src/domain/telemetry/fuelAlert.ts → isLowFuel(), driven end to end through the fuel detector
// Rule:    alert when the TRUSTED fuel value is below the profile's lowFuelPercent (15% for trucks). A glitch to 0%
//          never alerts; a real low level stays alerted even through a glitch or an unverified jump up.
// The mock server's real fuel takes hours to get low (and never goes below 5%) — these tests are how it's verified.
import { describe, expect, it } from 'vitest';
import { TelemetryReadingSchema, type TelemetryReading } from '../../../src/domain/models';
import { FUEL_CONFIRM_WINDOW_MS } from '../../../src/domain/telemetry/config';
import { fuelDetector } from '../../../src/domain/telemetry/detectors/fuel';
import { isLowFuel } from '../../../src/domain/telemetry/fuelAlert';
import type { SensorState } from '../../../src/domain/telemetry/sensors';
import { VEHICLE_PROFILES, type VehicleProfile } from '../../../src/domain/vehicles';
import { formatFuel, LOW_FUEL_FLAG } from '../../../src/ui/format';
import fuelGlitchFixture from '../../../fixtures/sse/fuel_glitch_sequence.json';
import telemetryFixture from '../../../fixtures/sse/telemetry.json';

const TRUCK = VEHICLE_PROFILES.truck;
const TICK_MS = 2000;

function reading(fuel: number, timestamp: number): TelemetryReading {
  return { ...TelemetryReadingSchema.parse(telemetryFixture.readings[0]), fuel, timestamp };
}

// Feeds fuel values (one per 2 s tick) through the fuel detector; returns the alert state after each reading.
function alertsFor(fuelValues: number[], profile: VehicleProfile = TRUCK): boolean[] {
  const alerts: boolean[] = [];
  let state: SensorState | undefined = undefined;
  fuelValues.forEach((fuel, index) => {
    state = fuelDetector.evaluate(state, reading(fuel, 100_000 + index * TICK_MS), profile);
    alerts.push(isLowFuel(state, profile));
  });
  return alerts;
}

describe('Low-fuel alert — real low fuel', () => {
  it('a normal level → no alert', () => {
    expect(alertsFor([73])).toEqual([false]);
  });

  it('a gradual real decrease alerts once the trusted value drops below 15%', () => {
    expect(alertsFor([15.4, 15.2, 15.0, 14.8, 14.6])).toEqual([false, false, false, true, true]);
  });

  it('exactly at the threshold is not low (strictly below)', () => {
    expect(alertsFor([15])).toEqual([false]);
  });

  it('a real 0% that holds past the confirm window → alerted (a real empty tank is never hidden)', () => {
    const ticks = FUEL_CONFIRM_WINDOW_MS / TICK_MS;
    const alerts = alertsFor([12, ...Array<number>(ticks + 1).fill(0)]);
    expect(alerts.at(-1)).toBe(true);
  });
});

describe('Low-fuel alert — glitches never raise a false alarm', () => {
  it('glitch 73 → 0 → 0 → 73: never alerts', () => {
    expect(alertsFor([73, 0, 0, 73])).toEqual([false, false, false, false]);
  });

  it('real captured glitch sequence from the server: never alerts', () => {
    const alerts: boolean[] = [];
    let state: SensorState | undefined = undefined;
    for (const entry of fuelGlitchFixture) {
      if (entry.type === 'telemetry' && 'reading' in entry) {
        state = fuelDetector.evaluate(state, TelemetryReadingSchema.parse(entry.reading), TRUCK);
        alerts.push(isLowFuel(state, TRUCK));
      }
    }
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((alert) => !alert)).toBe(true);
  });

  it('an impossible reading (-5%) while the tank is full → no alert (sensor fault, trusted value kept)', () => {
    expect(alertsFor([80, -5])).toEqual([false, false]);
  });
});

describe('Low-fuel alert — a real low level stays alerted', () => {
  it('real low 12% with a glitch to 0 → stays alerted (trusted value 12%)', () => {
    expect(alertsFor([12, 0, 0, 12])).toEqual([true, true, true, true]);
  });

  it('unverified sudden "rise" 10% → 80% → stays alerted until the rise is confirmed', () => {
    const ticks = FUEL_CONFIRM_WINDOW_MS / TICK_MS;
    const alerts = alertsFor([10, ...Array<number>(ticks + 1).fill(80)]);
    expect(alerts.slice(0, -1).every((alert) => alert)).toBe(true);
    expect(alerts.at(-1)).toBe(false);
  });

  it('the threshold comes from the vehicle profile', () => {
    const bigTank: VehicleProfile = { ...TRUCK, lowFuelPercent: 25 };
    expect(alertsFor([20], bigTank)).toEqual([true]);
    expect(alertsFor([20])).toEqual([false]);
  });
});

describe('Low-fuel alert — display', () => {
  it('low fuel shows "⛽ low fuel" next to the trusted value', () => {
    expect(formatFuel({ value: 12.4, status: 'ok' }, true)).toEqual({ text: '12 %', flag: LOW_FUEL_FLAG });
  });

  it('not low → the normal flags (e.g. "checking")', () => {
    expect(formatFuel({ value: 73, status: 'unverified', since: 1 }, false)).toEqual({ text: '73 %', flag: '⏳ checking' });
  });
});
