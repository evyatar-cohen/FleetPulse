// City regions for filtering trucks: four quadrants around the city center.
// The server has no regions, so we define them: the center is the mock server's CITY_CENTER (Tel Aviv) — no API
// exposes it. Pure functions: no I/O, no store, no React.
import type { Location } from './models';

export const CITY_CENTER: Location = { lat: 32.0853, lng: 34.7818 };

export const REGIONS = ['north-east', 'north-west', 'south-east', 'south-west'] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABELS: Readonly<Record<Region, string>> = {
  'north-east': 'North-East',
  'north-west': 'North-West',
  'south-east': 'South-East',
  'south-west': 'South-West',
};

// A point exactly on a center line counts as north / east (any fixed rule works; it just has to be one region).
export function regionOf(location: Location): Region {
  const north = location.lat >= CITY_CENTER.lat;
  const east = location.lng >= CITY_CENTER.lng;
  if (north) return east ? 'north-east' : 'north-west';
  return east ? 'south-east' : 'south-west';
}
