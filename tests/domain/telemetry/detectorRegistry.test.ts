// Feature: Sensor detector registry (extensibility — new sensor checks)
// Tests:   src/domain/telemetry/sensors.ts → evaluateSensors(); truckTelemetry.ts → ingestReading() wiring
// Rule:    the pipeline runs every detector in the list; adding a detector = one new module + one list entry,
//          no pipeline change. Detectors run only on accepted readings (late readings can't change sensors).
import { describe, expect, it } from 'vitest';
import { TelemetryReadingSchema, type TelemetryReading } from '../../../src/domain/models';
import { SENSOR_DETECTORS } from '../../../src/domain/telemetry/detectors';
import { evaluateSensors, type SensorDetector } from '../../../src/domain/telemetry/sensors';
import { ingestReading } from '../../../src/domain/telemetry/truckTelemetry';
import { VEHICLE_PROFILES } from '../../../src/domain/vehicles';
import telemetryFixture from '../../../fixtures/sse/telemetry.json';

const TRUCK = VEHICLE_PROFILES.truck;
const NOW = 1_000_000;
const CONTEXT = { now: NOW, profile: TRUCK };

function makeReading(overrides: Partial<TelemetryReading>): TelemetryReading {
  const reading = TelemetryReadingSchema.parse(telemetryFixture.readings[0]);
  return { ...reading, ...overrides };
}

// A fake detector, as a future feature would add (e.g. engine temperature).
const engineTempDetector: SensorDetector = {
  id: 'engineTemp',
  evaluate: (_previous, reading) => ({ value: reading.engineTemp, status: 'ok' }),
};

describe('Sensor detector registry', () => {
  it('the default registry includes the speed detector', () => {
    const ids = SENSOR_DETECTORS.map((detector) => detector.id);
    expect(ids).toContain('speed');
  });

  it('runs every detector in the list and keys results by detector id', () => {
    const sensors = evaluateSensors(undefined, makeReading({ speed: 40, engineTemp: 88 }), TRUCK, [
      ...SENSOR_DETECTORS,
      engineTempDetector,
    ]);
    expect(sensors.speed).toEqual({ value: 40, status: 'ok' });
    expect(sensors.engineTemp).toEqual({ value: 88, status: 'ok' });
  });

  it('passes each detector its own previous state', () => {
    const first = evaluateSensors(undefined, makeReading({ speed: 40, timestamp: 1000 }), TRUCK);
    const second = evaluateSensors(first, makeReading({ speed: 999, timestamp: 3000 }), TRUCK);
    expect(second.speed).toEqual({ value: 40, status: 'sensor_fault', since: 3000 });
  });
});

describe('Pipeline wiring: detectors run inside ingestReading', () => {
  it('an accepted reading updates sensor states', () => {
    const state = ingestReading(undefined, makeReading({ speed: 999, timestamp: NOW - 1000 }), CONTEXT).state;
    expect(state?.sensors.speed?.status).toBe('sensor_fault');
  });

  it('a late (stale) reading does not change sensor states', () => {
    let state = ingestReading(undefined, makeReading({ speed: 40, timestamp: NOW - 1000 }), CONTEXT).state;
    state = ingestReading(state, makeReading({ speed: 999, timestamp: NOW - 5000 }), CONTEXT).state;
    expect(state?.sensors.speed).toEqual({ value: 40, status: 'ok' });
  });
});
