// Feature: Vehicle detail data — trusted sensor history (charts), alert validation, chart drawing
// Tests:   src/domain/telemetry/truckTelemetry.ts (history), src/domain/alerts.ts, src/ui/chart.ts
// Rule:    charts use TRUSTED values only (never 999 km/h or a glitch 0%), bounded to MAX_HISTORY_SAMPLES; late readings
//          don't add samples; alert input is validated; unknown values break the chart line instead of being invented.
import { describe, expect, it } from 'vitest';
import { addAlert, alertNeedsConfirmation, ALERT_MESSAGE_MAX_LENGTH, MAX_ALERTS, validateAlert } from '../../src/domain/alerts';
import { AlertSchema, TelemetryReadingSchema, type Alert, type TelemetryReading } from '../../src/domain/models';
import { MAX_HISTORY_SAMPLES } from '../../src/domain/telemetry/config';
import { ingestReading, type TruckTelemetry } from '../../src/domain/telemetry/truckTelemetry';
import { VEHICLE_PROFILES } from '../../src/domain/vehicles';
import { chartRange, sparklineSegments } from '../../src/ui/chart';
import alertFixture from '../../fixtures/rest/alert_201.json';
import telemetryFixture from '../../fixtures/sse/telemetry.json';

const CONTEXT = { now: 10_000_000, profile: VEHICLE_PROFILES.truck };

function reading(timestamp: number, speed: number, fuel: number): TelemetryReading {
  return { ...TelemetryReadingSchema.parse(telemetryFixture.readings[0]), timestamp, speed, fuel };
}

function feed(readings: TelemetryReading[]): TruckTelemetry | undefined {
  let state: TruckTelemetry | undefined = undefined;
  for (const item of readings) state = ingestReading(state, item, CONTEXT).state;
  return state;
}

describe('Sensor history for charts', () => {
  it('stores TRUSTED values: a stuck 999 km/h is stored as the last valid speed', () => {
    const state = feed([reading(1000, 40, 70), reading(3000, 999, 70)]);
    expect(state?.history.map((sample) => sample.speed)).toEqual([40, 40]);
  });

  it('a fuel glitch to 0% is stored as the last trusted fuel, not 0', () => {
    const state = feed([reading(1000, 40, 73), reading(3000, 40, 0)]);
    expect(state?.history.map((sample) => sample.fuel)).toEqual([73, 73]);
  });

  it('a late (older) reading adds no sample', () => {
    const state = feed([reading(5000, 40, 70), reading(3000, 50, 70)]);
    expect(state?.history).toHaveLength(1);
  });

  it(`is bounded to ${MAX_HISTORY_SAMPLES} samples (≈5 minutes) — the oldest are dropped`, () => {
    const readings: TelemetryReading[] = [];
    for (let i = 1; i <= MAX_HISTORY_SAMPLES + 20; i++) readings.push(reading(i * 2000, 40, 70));
    const state = feed(readings);
    expect(state?.history).toHaveLength(MAX_HISTORY_SAMPLES);
    expect(state?.history[0]?.timestamp).toBe(21 * 2000);
  });
});

describe('Alerts', () => {
  it('message is trimmed; too short / too long → error', () => {
    expect(validateAlert({ message: '  Return to depot ', severity: 'warning' })).toEqual({
      ok: true,
      data: { message: 'Return to depot', severity: 'warning' },
    });
    expect(validateAlert({ message: ' ab ', severity: 'info' }).ok).toBe(false);
    expect(validateAlert({ message: 'x'.repeat(ALERT_MESSAGE_MAX_LENGTH + 1), severity: 'info' }).ok).toBe(false);
  });

  it('only critical alerts need confirmation', () => {
    expect(alertNeedsConfirmation('critical')).toBe(true);
    expect(alertNeedsConfirmation('warning')).toBe(false);
  });

  it('alerts list: duplicates ignored (same id), bounded', () => {
    const alert: Alert = AlertSchema.parse(alertFixture.body);
    const once = addAlert([], alert);
    expect(addAlert(once, alert)).toBe(once);
    let many: readonly Alert[] = [];
    for (let i = 0; i < MAX_ALERTS + 5; i++) many = addAlert(many, { ...alert, id: `a${i}` });
    expect(many).toHaveLength(MAX_ALERTS);
    expect(many[0]?.id).toBe('a5');
  });
});

describe('Chart drawing', () => {
  it('a null (no trusted value) breaks the line into two segments', () => {
    expect(sparklineSegments([1, 2, null, 3, 4], 40, 10, { min: 0, max: 4 })).toHaveLength(2);
  });

  it('values map inside the box: min at the bottom, max at the top', () => {
    const [segment] = sparklineSegments([0, 10], 100, 50, { min: 0, max: 10 });
    expect(segment).toBe('0.0,50.0 100.0,0.0');
  });

  it('range: fixed when given; padded for a flat line; safe when empty', () => {
    expect(chartRange([5, 7], { min: 0, max: 100 })).toEqual({ min: 0, max: 100 });
    expect(chartRange([5, 5])).toEqual({ min: 4, max: 6 });
    expect(chartRange([null, null])).toEqual({ min: 0, max: 1 });
  });
});
