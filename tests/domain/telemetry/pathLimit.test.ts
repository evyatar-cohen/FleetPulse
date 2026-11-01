// Feature: Bounded path (performance — the app must run for hours)
// Tests:   src/domain/telemetry/path.ts → addToPath()
// Rule:    a truck's path keeps at most MAX_PATH_POINTS (the recent tail). When full, the oldest point is
//          dropped. Full trip history belongs in a backend database, not in browser memory.
import { describe, expect, it } from 'vitest';
import { MAX_PATH_POINTS } from '../../../src/domain/telemetry/config';
import { addToPath, type PathPoint } from '../../../src/domain/telemetry/path';

function point(timestamp: number): PathPoint {
  return { lat: 32.08, lng: 34.78, timestamp };
}

// Builds a full path with timestamps 1, 2, …, MAX_PATH_POINTS (oldest first).
function fullPath(): readonly PathPoint[] {
  let path: readonly PathPoint[] = [];
  for (let timestamp = 1; timestamp <= MAX_PATH_POINTS; timestamp++) {
    path = addToPath(path, point(timestamp));
  }
  return path;
}

describe('Bounded path', () => {
  it('a full path stays at the limit when a new point is added', () => {
    const path = addToPath(fullPath(), point(MAX_PATH_POINTS + 1));
    expect(path).toHaveLength(MAX_PATH_POINTS);
  });

  it('the oldest point is dropped and the newest kept', () => {
    const path = addToPath(fullPath(), point(MAX_PATH_POINTS + 1));
    expect(path[0]?.timestamp).toBe(2);
    expect(path.at(-1)?.timestamp).toBe(MAX_PATH_POINTS + 1);
  });

  it('a late point older than everything in a full path is not added (path unchanged)', () => {
    const before = fullPath();
    const after = addToPath(before, point(0));
    expect(after).toBe(before);
  });

  it('a late point in the middle of a full path is inserted and the oldest dropped', () => {
    let path: readonly PathPoint[] = [];
    for (let i = 1; i <= MAX_PATH_POINTS; i++) {
      path = addToPath(path, point(i * 10));
    }
    const middle = (MAX_PATH_POINTS / 2) * 10 + 5;
    path = addToPath(path, point(middle));

    const timestamps = path.map((p) => p.timestamp);
    expect(path).toHaveLength(MAX_PATH_POINTS);
    expect(timestamps).toContain(middle);
    expect(timestamps).not.toContain(10);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('long run: 10,000 readings (~5.5 hours at 2 s) never exceed the limit', () => {
    let path: readonly PathPoint[] = [];
    for (let timestamp = 1; timestamp <= 10_000; timestamp++) {
      path = addToPath(path, point(timestamp * 2000));
      expect(path.length).toBeLessThanOrEqual(MAX_PATH_POINTS);
    }
    expect(path.at(-1)?.timestamp).toBe(10_000 * 2000);
  });
});
