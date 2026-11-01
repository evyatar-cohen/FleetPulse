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

  const inserted = [...path.slice(0, insertAt), point, ...path.slice(insertAt)];
  if (inserted.length > MAX_PATH_POINTS) {
    return inserted.slice(inserted.length - MAX_PATH_POINTS);
  }
  return inserted;
}
