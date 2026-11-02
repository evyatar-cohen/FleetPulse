// Store selectors, defined once outside components so they are stable functions (a hook can subscribe once).
import type { TruckView } from '../domain/fleet';
import type { FleetState } from '../store/fleetStore';

export function selectTrucks(state: FleetState): FleetState['trucks'] {
  return state.trucks;
}

// Stable display order: by name (Truck Alpha, Bravo, …).
export function sortedTrucks(trucks: FleetState['trucks']): TruckView[] {
  return Object.values(trucks).sort((a, b) => a.name.localeCompare(b.name));
}
