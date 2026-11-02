// Fleet view filter (bonus): status, fuel level, region, route assignment. Pure — used by the truck list (hides
// rows) and the map (dims markers, so the map scale doesn't jump when the filter changes).
// Fuel uses the TRUSTED value (same as the low-fuel alert), so a QUIRK #2 glitch to 0% doesn't make a truck "low".
// A truck with no known value for a filtered field (no reading yet, fuel not trusted yet) does NOT match: we only
// show what we can confirm.
import { truckStatus, type TruckView } from '../domain/fleet';
import type { TruckStatus } from '../domain/models';
import { regionOf, type Region } from '../domain/regions';
import { isLowFuel } from '../domain/telemetry/fuelAlert';
import { getVehicleProfile } from '../domain/vehicles';

export const HALF_TANK_PERCENT = 50;

export type FuelFilter = 'all' | 'low' | 'under-half';
export type RouteFilter = 'all' | 'assigned' | 'unassigned';

export interface TruckFilter {
  status: 'all' | TruckStatus;
  fuel: FuelFilter;
  region: 'all' | Region;
  route: RouteFilter;
}

export const NO_FILTER: TruckFilter = { status: 'all', fuel: 'all', region: 'all', route: 'all' };

export function isFiltering(filter: TruckFilter): boolean {
  return filter.status !== 'all' || filter.fuel !== 'all' || filter.region !== 'all' || filter.route !== 'all';
}

function matchesFuel(truck: TruckView, fuel: FuelFilter): boolean {
  if (fuel === 'all') return true;
  const trusted = truck.telemetry?.sensors['fuel'];
  if (trusted === undefined || trusted.value === null) return false;
  if (fuel === 'low') return isLowFuel(trusted, getVehicleProfile(truck.vehicleType));
  return trusted.value < HALF_TANK_PERCENT;
}

function matchesRegion(truck: TruckView, region: 'all' | Region): boolean {
  if (region === 'all') return true;
  const location = truck.telemetry?.current.location;
  return location !== undefined && regionOf(location) === region;
}

function matchesRoute(truck: TruckView, route: RouteFilter): boolean {
  if (route === 'all') return true;
  const assigned = truck.currentRouteId !== null;
  return route === 'assigned' ? assigned : !assigned;
}

export function matchesFilter(truck: TruckView, filter: TruckFilter): boolean {
  if (filter.status !== 'all' && truckStatus(truck) !== filter.status) return false;
  return matchesFuel(truck, filter.fuel) && matchesRegion(truck, filter.region) && matchesRoute(truck, filter.route);
}
