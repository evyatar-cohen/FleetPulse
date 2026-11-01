// Feature: GPS batch (QUIRK #1)
// Tests:   src/domain/telemetry/truckTelemetry.ts → ingestBatch(), ingestReading() path handling
// Rule:    a batch of old readings never moves the truck's marker backwards; its positions fill the path
//          (sorted by timestamp). One current position per truck, never 30 markers.
import { describe, expect, it } from 'vitest';
import { SseEventSchema } from '../../../src/domain/events';
import { VEHICLE_PROFILES } from '../../../src/domain/vehicles';
import { TelemetryReadingSchema, type TelemetryReading } from '../../../src/domain/models';
import {
  ingestBatch,
  ingestReading,
  type IngestContext,
  type TruckTelemetry,
} from '../../../src/domain/telemetry/truckTelemetry';
import batchContextFixture from '../../../fixtures/sse/gps_batch_context.json';
import batchFixture from '../../../fixtures/sse/gps_batch.json';
import telemetryFixture from '../../../fixtures/sse/telemetry.json';

const NOW = 1_000_000;

// Ingest context for a truck at a given server time.
function at(now: number): IngestContext {
  return { now, profile: VEHICLE_PROFILES.truck };
}

function makeReading(overrides: Partial<TelemetryReading>): TelemetryReading {
  const event = SseEventSchema.parse(telemetryFixture);
  if (event.type !== 'telemetry' || event.readings[0] === undefined) {
    throw new Error('telemetry fixture has no readings');
  }
  return { ...event.readings[0], ...overrides };
}

function pathTimestamps(state: TruckTelemetry | undefined): number[] {
  if (state === undefined) return [];
  return state.path.map((point) => point.timestamp);
}

describe('GPS batch (QUIRK #1)', () => {
  it('a batch of older readings does not change the current position', () => {
    const live = makeReading({ timestamp: NOW - 1000, location: { lat: 32.1, lng: 34.8 } });
    const batch = [
      makeReading({ timestamp: NOW - 7000, location: { lat: 32.0, lng: 34.7 } }),
      makeReading({ timestamp: NOW - 5000, location: { lat: 32.01, lng: 34.71 } }),
      makeReading({ timestamp: NOW - 3000, location: { lat: 32.02, lng: 34.72 } }),
    ];
    const state = ingestBatch(ingestReading(undefined, live, at(NOW)).state, batch, at(NOW));
    expect(state?.current).toEqual(live);
  });

  it('batch positions are added to the path, sorted by timestamp', () => {
    const live = makeReading({ timestamp: NOW - 1000 });
    const batch = [
      makeReading({ timestamp: NOW - 7000 }),
      makeReading({ timestamp: NOW - 5000 }),
      makeReading({ timestamp: NOW - 3000 }),
    ];
    const state = ingestBatch(ingestReading(undefined, live, at(NOW)).state, batch, at(NOW));
    expect(pathTimestamps(state)).toEqual([NOW - 7000, NOW - 5000, NOW - 3000, NOW - 1000]);
  });

  it('batch readings in mixed order still produce a sorted path', () => {
    const batch = [
      makeReading({ timestamp: NOW - 3000 }),
      makeReading({ timestamp: NOW - 7000 }),
      makeReading({ timestamp: NOW - 5000 }),
    ];
    const state = ingestBatch(undefined, batch, at(NOW));
    expect(pathTimestamps(state)).toEqual([NOW - 7000, NOW - 5000, NOW - 3000]);
  });

  it('a batch before any live reading: its newest reading becomes the current state', () => {
    const newest = makeReading({ timestamp: NOW - 3000 });
    const batch = [makeReading({ timestamp: NOW - 7000 }), newest, makeReading({ timestamp: NOW - 5000 })];
    const state = ingestBatch(undefined, batch, at(NOW));
    expect(state?.current).toEqual(newest);
  });

  it('a late single reading (QUIRK #5) also adds its position to the path', () => {
    const live = makeReading({ timestamp: NOW - 1000 });
    const late = makeReading({ timestamp: NOW - 4000 });
    let state = ingestReading(undefined, live, at(NOW)).state;
    state = ingestReading(state, late, at(NOW)).state;
    expect(pathTimestamps(state)).toEqual([NOW - 4000, NOW - 1000]);
  });

  it('the same timestamp is never added to the path twice', () => {
    const live = makeReading({ timestamp: NOW - 1000 });
    const batch = [makeReading({ timestamp: NOW - 3000 }), makeReading({ timestamp: NOW - 3000 })];
    let state = ingestReading(undefined, live, at(NOW)).state;
    state = ingestBatch(state, batch, at(NOW));
    state = ingestReading(state, live, at(NOW)).state;
    expect(pathTimestamps(state)).toEqual([NOW - 3000, NOW - 1000]);
  });

  it('a rejected future reading is not added to the path', () => {
    const live = makeReading({ timestamp: NOW - 1000 });
    const future = makeReading({ timestamp: NOW + 10 * 60_000 });
    const state = ingestBatch(ingestReading(undefined, live, at(NOW)).state, [future], at(NOW));
    expect(pathTimestamps(state)).toEqual([NOW - 1000]);
  });

  it('real server data: batch between live ticks → one current position (the newest live tick), full path', () => {
    let state: TruckTelemetry | undefined = undefined;
    let newestLive: TelemetryReading | undefined = undefined;
    let batchSize = 0;

    // Replay the captured sequence in arrival order, as the store will do.
    for (const entry of batchContextFixture) {
      if (entry.type === 'telemetry' && 'reading' in entry && entry.eventTimestamp !== undefined) {
        const reading = TelemetryReadingSchema.parse(entry.reading);
        state = ingestReading(state, reading, at(entry.eventTimestamp)).state;
        newestLive = reading;
      } else if (entry.type === 'gps_batch' && 'readings' in entry) {
        const batch = SseEventSchema.parse(entry);
        if (batch.type !== 'gps_batch') throw new Error('not a gps_batch');
        batchSize = batch.readings.length;
        state = ingestBatch(state, batch.readings, at(entry.receivedAt));
      }
    }

    expect(state?.current).toEqual(newestLive);
    const timestamps = pathTimestamps(state);
    expect(timestamps.length).toBeGreaterThanOrEqual(batchSize);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('real server data: a 12-reading batch on its own → one current position, 12 path points', () => {
    const event = SseEventSchema.parse(batchFixture);
    if (event.type !== 'gps_batch') throw new Error('not a gps_batch');
    const newestTimestamp = Math.max(...event.readings.map((reading) => reading.timestamp));
    const state = ingestBatch(undefined, event.readings, at(newestTimestamp));
    expect(state?.current.timestamp).toBe(newestTimestamp);
    expect(state?.path).toHaveLength(event.readings.length);
  });
});
