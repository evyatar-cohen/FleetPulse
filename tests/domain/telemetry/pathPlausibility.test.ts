// Feature: Path plausibility filter (QUIRK #1 — GPS batch positions are random jitter around the current position)
// Tests:   src/domain/telemetry/path.ts → isPlausiblePathPoint(); truckTelemetry.ts → ingestReading() for late readings
// Rule:    a LATE reading's position is added to the path only if reaching it from its time-neighbors needs no more
//          than the vehicle's max speed. The CURRENT (accepted) position is always added — the marker is the truth.
import { describe, expect, it } from 'vitest';
import { SseEventSchema } from '../../../src/domain/events';
import { TelemetryReadingSchema, type TelemetryReading } from '../../../src/domain/models';
import { distanceMeters, isPlausiblePathPoint, type PathPoint } from '../../../src/domain/telemetry/path';
import { ingestBatch, ingestReading, type TruckTelemetry } from '../../../src/domain/telemetry/truckTelemetry';
import { VEHICLE_PROFILES } from '../../../src/domain/vehicles';
import batchContextFixture from '../../../fixtures/sse/gps_batch_context.json';
import telemetryFixture from '../../../fixtures/sse/telemetry.json';

const TRUCK = VEHICLE_PROFILES.truck;
const BASE = { lat: 32.08, lng: 34.78 };
// ~111 m per 0.001° of latitude.
const METERS_PER_MILLI_DEGREE_LAT = 111;

function point(timestamp: number, latOffset = 0): PathPoint {
  return { lat: BASE.lat + latOffset, lng: BASE.lng, timestamp };
}

function reading(timestamp: number, latOffset = 0): TelemetryReading {
  const template = TelemetryReadingSchema.parse(telemetryFixture.readings[0]);
  return { ...template, location: { lat: BASE.lat + latOffset, lng: BASE.lng }, timestamp };
}

function context(now: number): { now: number; profile: typeof TRUCK } {
  return { now, profile: TRUCK };
}

describe('Path plausibility — distance', () => {
  it('distanceMeters: 0.001° of latitude ≈ 111 m', () => {
    const meters = distanceMeters(point(0), point(0, 0.001));
    expect(Math.abs(meters - METERS_PER_MILLI_DEGREE_LAT)).toBeLessThan(2);
  });
});

describe('Path plausibility — late points', () => {
  const path: PathPoint[] = [point(0), point(2000, 0.0001), point(4000, 0.0002)];

  it('a late point near its neighbors (normal driving) is plausible', () => {
    expect(isPlausiblePathPoint(path, point(3000, 0.00015), TRUCK.maxSpeedKmh)).toBe(true);
  });

  it('a late point 150 m away from neighbors 1 s apart (≈ 540 km/h) is NOT plausible', () => {
    expect(isPlausiblePathPoint(path, point(3000, 0.00135), TRUCK.maxSpeedKmh)).toBe(false);
  });

  it('a late point a few ms from a neighbor but far away is NOT plausible (batch timestamps align with ticks)', () => {
    expect(isPlausiblePathPoint(path, point(2003, 0.001), TRUCK.maxSpeedKmh)).toBe(false);
  });

  it('an empty path accepts any point', () => {
    expect(isPlausiblePathPoint([], point(0, 1), TRUCK.maxSpeedKmh)).toBe(true);
  });
});

describe('Path plausibility — inside ingestReading', () => {
  it('a late jittered reading is NOT added to the path (marker unchanged as before)', () => {
    let state: TruckTelemetry | undefined = ingestReading(undefined, reading(1000), context(5000)).state;
    state = ingestReading(state, reading(3000, 0.00005), context(5000)).state;
    const before = state?.path.length ?? 0;
    state = ingestReading(state, reading(2001, 0.0015), context(5000)).state;
    expect(state?.path).toHaveLength(before);
  });

  it('the CURRENT position is always added, even after a big jump (e.g. after a long gap)', () => {
    let state: TruckTelemetry | undefined = ingestReading(undefined, reading(1000), context(5000)).state;
    state = ingestReading(state, reading(3000, 0.05), context(5000)).state;
    expect(state?.path.at(-1)?.timestamp).toBe(3000);
    expect(state?.current.timestamp).toBe(3000);
  });

  it('real server data: after the captured batch, no path segment next to a batch point implies > max speed', () => {
    let state: TruckTelemetry | undefined = undefined;
    for (const entry of batchContextFixture) {
      if (entry.type === 'telemetry' && 'reading' in entry && entry.eventTimestamp !== undefined) {
        state = ingestReading(state, TelemetryReadingSchema.parse(entry.reading), context(entry.eventTimestamp)).state;
      } else if (entry.type === 'gps_batch') {
        const batch = SseEventSchema.parse(entry);
        if (batch.type !== 'gps_batch') throw new Error('not a batch');
        state = ingestBatch(state, batch.readings, context(entry.receivedAt));
      }
    }
    const path = state?.path ?? [];
    const liveTimestamps = new Set<number>();
    for (const entry of batchContextFixture) {
      if (entry.type === 'telemetry' && 'reading' in entry && entry.reading !== undefined) {
        liveTimestamps.add(entry.reading.timestamp);
      }
    }
    for (let i = 1; i < path.length; i++) {
      const previous = path[i - 1];
      const current = path[i];
      if (previous === undefined || current === undefined) continue;
      const involvesLatePoint = !liveTimestamps.has(previous.timestamp) || !liveTimestamps.has(current.timestamp);
      if (!involvesLatePoint) continue;
      const hours = Math.max(current.timestamp - previous.timestamp, 1) / 3_600_000;
      const kmh = distanceMeters(previous, current) / 1000 / hours;
      expect(kmh).toBeLessThanOrEqual(TRUCK.maxSpeedKmh);
    }
  });
});
