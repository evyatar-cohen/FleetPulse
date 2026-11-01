// Feature: Out-of-order readings (QUIRK #5)
// Tests:   src/domain/telemetry/truckTelemetry.ts → ingestReading()
// Rule:    the truck's current state follows the reading TIMESTAMP, not the arrival order.
//          Readings too far in the future (clock bug) are rejected so they can't block real ones.
import { describe, expect, it } from 'vitest';
import { SseEventSchema } from '../../../src/domain/events';
import { VEHICLE_PROFILES } from '../../../src/domain/vehicles';
import type { TelemetryReading } from '../../../src/domain/models';
import { MAX_FUTURE_SKEW_MS } from '../../../src/domain/telemetry/config';
import { ingestReading, type IngestContext, type TruckTelemetry } from '../../../src/domain/telemetry/truckTelemetry';
import reorderedFixture from '../../../fixtures/sse/telemetry_reordered.json';
import telemetryFixture from '../../../fixtures/sse/telemetry.json';

// Fixed "current time" so tests never depend on the real clock.
const NOW = 1_000_000;

// Ingest context for a truck at a given server time.
function at(now: number): IngestContext {
  return { now, profile: VEHICLE_PROFILES.truck };
}

// A real reading from the server, used as a template. Tests change only the fields they care about.
function makeReading(overrides: Partial<TelemetryReading>): TelemetryReading {
  const event = SseEventSchema.parse(telemetryFixture);
  if (event.type !== 'telemetry' || event.readings[0] === undefined) {
    throw new Error('telemetry fixture has no readings');
  }
  return { ...event.readings[0], ...overrides };
}

// Feeds readings one by one, in arrival order, and returns the final state.
function ingestAll(readings: TelemetryReading[]): TruckTelemetry | undefined {
  let state: TruckTelemetry | undefined = undefined;
  for (const reading of readings) {
    state = ingestReading(state, reading, at(NOW)).state;
  }
  return state;
}

describe('Out-of-order readings (QUIRK #5)', () => {
  it('first reading for a truck becomes its current state', () => {
    const reading = makeReading({ timestamp: NOW - 2000 });
    const result = ingestReading(undefined, reading, at(NOW));
    expect(result.outcome).toBe('accepted');
    expect(result.state?.current).toEqual(reading);
  });

  it('a newer reading replaces the current state', () => {
    const first = makeReading({ timestamp: NOW - 4000, speed: 30 });
    const newer = makeReading({ timestamp: NOW - 2000, speed: 40 });
    expect(ingestAll([first, newer])?.current).toEqual(newer);
  });

  it('an older reading arriving later does NOT replace the current state (truck does not jump back)', () => {
    const newer = makeReading({ timestamp: NOW - 2000, speed: 40, location: { lat: 32.1, lng: 34.8 } });
    const older = makeReading({ timestamp: NOW - 8000, speed: 10, location: { lat: 32.0, lng: 34.7 } });
    const state = ingestAll([newer]);
    const result = ingestReading(state, older, at(NOW));
    expect(result.outcome).toBe('stale');
    expect(result.state?.current).toEqual(newer);
  });

  it('a reading with the same timestamp as the current one is ignored (duplicate)', () => {
    const first = makeReading({ timestamp: NOW - 2000, speed: 40 });
    const duplicate = makeReading({ timestamp: NOW - 2000, speed: 99 });
    const result = ingestReading(ingestAll([first]), duplicate, at(NOW));
    expect(result.outcome).toBe('duplicate');
    expect(result.state?.current).toEqual(first);
  });

  it('a newer reading after a long gap (stream paused) is accepted', () => {
    const old = makeReading({ timestamp: NOW - 600_000 });
    const resumed = makeReading({ timestamp: NOW - 1000 });
    expect(ingestAll([old, resumed])?.current).toEqual(resumed);
  });

  it('real server data: the _reordered reading does not override a newer one', () => {
    const event = SseEventSchema.parse(reorderedFixture);
    if (event.type !== 'telemetry') throw new Error('fixture is not a telemetry event');
    const late = event.readings.find((reading) => reading._reordered === true);
    if (late === undefined) throw new Error('fixture has no reordered reading');

    // What the previous tick (2 s before this event) delivered for the same truck — newer than the late one.
    const previousTick = { ...late, timestamp: event.timestamp - 2000, _reordered: undefined };
    const state = ingestReading(undefined, previousTick, at(event.timestamp)).state;
    const result = ingestReading(state, late, at(event.timestamp));
    expect(result.outcome).toBe('stale');
    expect(result.state?.current).toEqual(previousTick);
  });

  it('does not modify the state object it was given (returns a new one)', () => {
    const before = ingestAll([makeReading({ timestamp: NOW - 4000 })]);
    const snapshot = structuredClone(before);
    ingestReading(before, makeReading({ timestamp: NOW - 2000 }), at(NOW));
    expect(before).toEqual(snapshot);
  });
});

describe('Future timestamps (clock bug guard)', () => {
  it('a reading too far in the future is rejected and does not become current', () => {
    const current = makeReading({ timestamp: NOW - 2000 });
    const future = makeReading({ timestamp: NOW + MAX_FUTURE_SKEW_MS + 1 });
    const result = ingestReading(ingestAll([current]), future, at(NOW));
    expect(result.outcome).toBe('future');
    expect(result.state?.current).toEqual(current);
  });

  it('a future reading as the FIRST reading is rejected (no state created)', () => {
    const future = makeReading({ timestamp: NOW + MAX_FUTURE_SKEW_MS + 1 });
    const result = ingestReading(undefined, future, at(NOW));
    expect(result.outcome).toBe('future');
    expect(result.state).toBeUndefined();
  });

  it('a reading slightly ahead (within tolerance, small clock difference) is accepted', () => {
    const slightlyAhead = makeReading({ timestamp: NOW + MAX_FUTURE_SKEW_MS });
    const result = ingestReading(undefined, slightlyAhead, at(NOW));
    expect(result.outcome).toBe('accepted');
  });

  it('after a rejected future reading, normal readings keep updating the truck', () => {
    const future = makeReading({ timestamp: NOW + 10 * MAX_FUTURE_SKEW_MS });
    const normal = makeReading({ timestamp: NOW - 1000, speed: 42 });
    expect(ingestAll([future, normal])?.current).toEqual(normal);
  });
});
