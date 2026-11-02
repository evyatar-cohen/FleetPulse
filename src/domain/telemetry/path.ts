// The route a truck has driven, as a list of positions sorted by measurement time.
// Fed by truckTelemetry.ts with both current and late (stale / batch) readings. Pure, immutable.
// Bounded to MAX_PATH_POINTS (the recent tail) so memory stays fixed over hours.
import type { Location } from '../models';
import { MAX_PATH_POINTS } from './config';

export interface PathPoint extends Location {
  timestamp: number;
}

// Returns a new path with `point` inserted in timestamp order; if over the limit, the oldest point is dropped.
// Returns the SAME array when nothing changes: duplicate timestamp, or a full path and a point older than all.
export function addToPath(path: readonly PathPoint[], point: PathPoint): readonly PathPoint[] {
  // Search from the end: most points are newer than everything already in the path.
  let insertAt = path.length;
  while (insertAt > 0) {
    const before = path[insertAt - 1];
    if (before === undefined || before.timestamp < point.timestamp) {
      break;
    }
    if (before.timestamp === point.timestamp) {
      return path;
    }
    insertAt--;
  }

  const isFull = path.length >= MAX_PATH_POINTS;
  // Older than everything in a full path: it would be dropped right away.
  if (isFull && insertAt === 0) {
    return path;
  }

  // When full, skip the oldest point while copying — one copy per insert.
  const firstKept = isFull ? 1 : 0;
  return [...path.slice(firstKept, insertAt), point, ...path.slice(insertAt)];
}

const EARTH_RADIUS_METERS = 6_371_000;
const DEGREES_TO_RADIANS = Math.PI / 180;

// Distance between two positions. Flat-earth approximation — accurate to well under 1% at city scale.
export function distanceMeters(a: Location, b: Location): number {
  const meanLatRadians = ((a.lat + b.lat) / 2) * DEGREES_TO_RADIANS;
  const dx = (b.lng - a.lng) * DEGREES_TO_RADIANS * Math.cos(meanLatRadians) * EARTH_RADIUS_METERS;
  const dy = (b.lat - a.lat) * DEGREES_TO_RADIANS * EARTH_RADIUS_METERS;
  return Math.sqrt(dx * dx + dy * dy);
}

function impliedSpeedKmh(a: PathPoint, b: PathPoint): number {
  // At least 1 ms, so two points with (almost) the same time but different places count as "impossibly fast".
  const hours = Math.max(Math.abs(b.timestamp - a.timestamp), 1) / 3_600_000;
  return distanceMeters(a, b) / 1000 / hours;
}

// QUIRK #1: GPS batch positions are random jitter (±~100 m) around the CURRENT position with old timestamps, so
// sorting them by time draws an impossible zig-zag. A late point is plausible only if reaching it from its
// time-neighbors (the points just before and after it) needs no more than the vehicle's max speed.
// Generic — the same "physically impossible" rule as the speed detector, not a batch-specific hack.
export function isPlausiblePathPoint(path: readonly PathPoint[], point: PathPoint, maxSpeedKmh: number): boolean {
  let before: PathPoint | undefined;
  let after: PathPoint | undefined;
  for (const existing of path) {
    if (existing.timestamp <= point.timestamp) {
      before = existing;
    } else {
      after = existing;
      break;
    }
  }
  if (before !== undefined && impliedSpeedKmh(before, point) > maxSpeedKmh) return false;
  if (after !== undefined && impliedSpeedKmh(point, after) > maxSpeedKmh) return false;
  return true;
}
