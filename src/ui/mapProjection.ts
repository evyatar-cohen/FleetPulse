// Map projection for the SVG coordinate grid: turns lat/lng into x/y inside a fixed-size drawing area.
// The area fits all known positions (with a margin), so the whole fleet is always visible.
// Simple linear mapping — fine for a city-sized area (no map distortion worth correcting).
import type { Location } from '../domain/models';

export interface Point {
  x: number;
  y: number;
}

export interface Projection {
  toPoint: (location: Location) => Point;
}

export const MAP_SIZE = { width: 800, height: 600, margin: 30 } as const;

// Smallest span we allow, so a single truck (or trucks very close together) doesn't zoom in absurdly.
const MIN_SPAN_DEGREES = 0.01;

export function createProjection(locations: readonly Location[]): Projection {
  if (locations.length === 0) {
    return { toPoint: () => ({ x: MAP_SIZE.width / 2, y: MAP_SIZE.height / 2 }) };
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const location of locations) {
    minLat = Math.min(minLat, location.lat);
    maxLat = Math.max(maxLat, location.lat);
    minLng = Math.min(minLng, location.lng);
    maxLng = Math.max(maxLng, location.lng);
  }

  const latSpan = Math.max(maxLat - minLat, MIN_SPAN_DEGREES);
  const lngSpan = Math.max(maxLng - minLng, MIN_SPAN_DEGREES);
  const drawWidth = MAP_SIZE.width - 2 * MAP_SIZE.margin;
  const drawHeight = MAP_SIZE.height - 2 * MAP_SIZE.margin;

  return {
    toPoint: (location) => ({
      x: MAP_SIZE.margin + ((location.lng - minLng) / lngSpan) * drawWidth,
      // Screen y grows downwards, latitude grows northwards → flip.
      y: MAP_SIZE.margin + ((maxLat - location.lat) / latSpan) * drawHeight,
    }),
  };
}
