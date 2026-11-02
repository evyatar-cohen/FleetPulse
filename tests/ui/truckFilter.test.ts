// Feature: Filterable fleet view (bonus)
// Tests:   src/ui/truckFilter.ts → matchesFilter(), isFiltering(); src/domain/regions.ts → regionOf()
// Rule:    filters combine with AND; fuel uses the TRUSTED value; unknown values don't match a filter on that field.
import { describe, expect, it } from 'vitest';
import { applyFleetSnapshot, type TruckView } from '../../src/domain/fleet';
import { FleetResponseSchema } from '../../src/domain/api';
import type { FleetTruck } from '../../src/domain/models';
import { CITY_CENTER, regionOf } from '../../src/domain/regions';
import { isFiltering, matchesFilter, NO_FILTER, type TruckFilter } from '../../src/ui/truckFilter';
import fleetFixture from '../../fixtures/rest/fleet_200.json';

const base = FleetResponseSchema.parse(fleetFixture.body).fleet[0] as FleetTruck;

function truckWith(changes: Partial<FleetTruck>): TruckView {
  const fleetTruck: FleetTruck = { ...base, ...changes };
  const trucks = applyFleetSnapshot({}, [fleetTruck], Date.now());
  return trucks[fleetTruck.id] as TruckView;
}

function filter(changes: Partial<TruckFilter>): TruckFilter {
  return { ...NO_FILTER, ...changes };
}

const NORTH_EAST = { lat: CITY_CENTER.lat + 0.01, lng: CITY_CENTER.lng + 0.01 };
const SOUTH_WEST = { lat: CITY_CENTER.lat - 0.01, lng: CITY_CENTER.lng - 0.01 };

describe('Filterable fleet view', () => {
  it('no filter → every truck matches', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(matchesFilter(truckWith({ status: 'maintenance', fuel: 5 }), NO_FILTER)).toBe(true);
  });

  it('status filter uses the live status', () => {
    expect(matchesFilter(truckWith({ status: 'idle' }), filter({ status: 'idle' }))).toBe(true);
    expect(matchesFilter(truckWith({ status: 'active' }), filter({ status: 'idle' }))).toBe(false);
  });

  it('fuel: "low" follows the vehicle profile threshold; "under half" is < 50%', () => {
    const nearlyEmpty = truckWith({ fuel: 8 });
    const thirty = truckWith({ fuel: 30 });
    const full = truckWith({ fuel: 90 });
    expect(matchesFilter(nearlyEmpty, filter({ fuel: 'low' }))).toBe(true);
    expect(matchesFilter(thirty, filter({ fuel: 'low' }))).toBe(false);
    expect(matchesFilter(thirty, filter({ fuel: 'under-half' }))).toBe(true);
    expect(matchesFilter(full, filter({ fuel: 'under-half' }))).toBe(false);
  });

  it('region: quadrant around the city center', () => {
    expect(regionOf(NORTH_EAST)).toBe('north-east');
    expect(regionOf(SOUTH_WEST)).toBe('south-west');
    expect(matchesFilter(truckWith({ location: NORTH_EAST }), filter({ region: 'north-east' }))).toBe(true);
    expect(matchesFilter(truckWith({ location: SOUTH_WEST }), filter({ region: 'north-east' }))).toBe(false);
  });

  it('route assignment', () => {
    const busy = truckWith({ currentRouteId: 'route_1' });
    const free = truckWith({ currentRouteId: null });
    expect(matchesFilter(busy, filter({ route: 'assigned' }))).toBe(true);
    expect(matchesFilter(free, filter({ route: 'assigned' }))).toBe(false);
    expect(matchesFilter(free, filter({ route: 'unassigned' }))).toBe(true);
  });

  it('filters combine with AND', () => {
    const truck = truckWith({ status: 'active', fuel: 30, location: NORTH_EAST, currentRouteId: null });
    expect(matchesFilter(truck, filter({ status: 'active', fuel: 'under-half', region: 'north-east' }))).toBe(true);
    expect(matchesFilter(truck, filter({ status: 'active', fuel: 'under-half', route: 'assigned' }))).toBe(false);
  });
});
