// Feature: What the dispatcher sees (formatting + map projection)
// Tests:   src/ui/format.ts, src/ui/mapProjection.ts
// Rule:    only trusted sensor values are shown, with a flag when not fully trusted; unknown → "—";
//          the map fits every truck inside the drawing area, north up.
import { describe, expect, it } from 'vitest';
import { formatAge, formatFuel, formatSpeed } from '../../src/ui/format';
import { createProjection, MAP_SIZE } from '../../src/ui/mapProjection';

describe('Sensor formatting', () => {
  it('ok sensor → value with unit, no flag', () => {
    expect(formatSpeed({ value: 42.4, status: 'ok' })).toEqual({ text: '42 km/h', flag: null });
  });

  it('stuck speed sensor → last trusted value + "sensor fault" (never 999)', () => {
    expect(formatSpeed({ value: 40, status: 'sensor_fault', since: 1 })).toEqual({ text: '40 km/h', flag: '⚠ sensor fault' });
  });

  it('fuel glitch being checked → last trusted value + "checking"', () => {
    expect(formatFuel({ value: 73.6, status: 'unverified', since: 1 })).toEqual({ text: '74 %', flag: '⏳ checking' });
  });

  it('no trusted value yet → "—" (with the flag if faulty)', () => {
    expect(formatSpeed({ value: null, status: 'sensor_fault', since: 1 })).toEqual({ text: '—', flag: '⚠ sensor fault' });
    expect(formatSpeed(undefined)).toEqual({ text: '—', flag: null });
  });
});

describe('Age formatting', () => {
  it('seconds, then minutes; never negative', () => {
    expect(formatAge(10_000, 14_000)).toBe('4 s ago');
    expect(formatAge(0, 125_000)).toBe('2 min ago');
    expect(formatAge(20_000, 10_000)).toBe('0 s ago');
    expect(formatAge(undefined, 1)).toBe('no data yet');
  });
});

describe('Map projection', () => {
  const north = { lat: 32.12, lng: 34.78 };
  const south = { lat: 32.04, lng: 34.78 };
  const west = { lat: 32.08, lng: 34.74 };
  const east = { lat: 32.08, lng: 34.82 };

  it('every location lands inside the drawing area (within the margin)', () => {
    const projection = createProjection([north, south, west, east]);
    for (const location of [north, south, west, east]) {
      const point = projection.toPoint(location);
      expect(point.x).toBeGreaterThanOrEqual(MAP_SIZE.margin);
      expect(point.x).toBeLessThanOrEqual(MAP_SIZE.width - MAP_SIZE.margin);
      expect(point.y).toBeGreaterThanOrEqual(MAP_SIZE.margin);
      expect(point.y).toBeLessThanOrEqual(MAP_SIZE.height - MAP_SIZE.margin);
    }
  });

  it('north is up and east is right', () => {
    const projection = createProjection([north, south, west, east]);
    expect(projection.toPoint(north).y).toBeLessThan(projection.toPoint(south).y);
    expect(projection.toPoint(east).x).toBeGreaterThan(projection.toPoint(west).x);
  });

  it('no locations or a single truck → no crash, a point inside the area', () => {
    expect(createProjection([]).toPoint(north)).toEqual({ x: MAP_SIZE.width / 2, y: MAP_SIZE.height / 2 });
    const single = createProjection([north]).toPoint(north);
    expect(Number.isFinite(single.x) && Number.isFinite(single.y)).toBe(true);
  });
});
