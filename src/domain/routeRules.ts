// Route business rules. The server accepts ANY status and destination (and even creates a route on a truck in
// maintenance), so the client enforces the rules: the UI uses them to disable invalid actions, and the actions check
// them again before sending. Pure functions. (A real backend must enforce them too — client checks are UX, not security.)
import { err, ok, type Result } from './result';
import { truckStatus, type Trucks, type TruckView } from './fleet';
import type { Route, RoutePriority, RouteStatus } from './models';
import { isFinished } from './routes';

export const DESTINATION_MIN_LENGTH: number = 3;
export const DESTINATION_MAX_LENGTH: number = 200;
export const NOTES_MAX_LENGTH: number = 500;
export const DEFAULT_PRIORITY: RoutePriority = 'normal';

// The allowed next statuses. A registry: the whole lifecycle in one table.
const NEXT_STATUSES: Readonly<Record<RouteStatus, readonly RouteStatus[]>> = {
  assigned: ['in-progress', 'cancelled'],
  'in-progress': ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function allowedNextStatuses(status: RouteStatus): readonly RouteStatus[] {
  return NEXT_STATUSES[status];
}

export function canTransition(from: RouteStatus, to: RouteStatus): boolean {
  return NEXT_STATUSES[from].includes(to);
}

// Why this truck can't take a new route, or null if it can.
export function whyTruckCannotTakeRoute(truck: TruckView | undefined): string | null {
  if (truck === undefined) return 'Truck not found';
  if (truckStatus(truck) === 'maintenance') return 'Truck is in maintenance';
  if (truck.currentRouteId !== null) return 'Truck already has a route';
  return null;
}

// What the dispatcher typed in the "new route" form.
export interface NewRouteDraft {
  truckId: string;
  destination: string;
  priority?: RoutePriority;
  notes?: string;
}

// A cleaned, valid new route (trimmed, defaults filled) — ready to send.
export interface ValidNewRoute {
  truckId: string;
  destination: string;
  priority: RoutePriority;
  notes: string;
}

// Field → message, for showing errors next to the form fields.
export type FieldErrors = Partial<Record<keyof NewRouteDraft, string>>;

export function validateNewRoute(draft: NewRouteDraft, trucks: Trucks): Result<ValidNewRoute, FieldErrors> {
  const errors: FieldErrors = {};
  const destination = draft.destination.trim();
  const notes = (draft.notes ?? '').trim();

  if (destination.length < DESTINATION_MIN_LENGTH) {
    errors.destination = `Destination must be at least ${DESTINATION_MIN_LENGTH} characters`;
  } else if (destination.length > DESTINATION_MAX_LENGTH) {
    errors.destination = `Destination must be at most ${DESTINATION_MAX_LENGTH} characters`;
  }
  if (notes.length > NOTES_MAX_LENGTH) {
    errors.notes = `Notes must be at most ${NOTES_MAX_LENGTH} characters`;
  }
  const truckProblem = whyTruckCannotTakeRoute(trucks[draft.truckId]);
  if (truckProblem !== null) {
    errors.truckId = truckProblem;
  }

  if (Object.keys(errors).length > 0) {
    return err(errors);
  }
  return ok({ truckId: draft.truckId, destination, priority: draft.priority ?? DEFAULT_PRIORITY, notes });
}

// Reassign has NO version check on the server, so these checks are the only guard before sending.
export function validateReassign(route: Route, targetTruckId: string, trucks: Trucks): Result<null, string> {
  if (isFinished(route)) return err(`Route is ${route.status}`);
  if (targetTruckId === route.truckId) return err('Route is already on this truck');
  const problem = whyTruckCannotTakeRoute(trucks[targetTruckId]);
  if (problem !== null) return err(problem);
  return ok(null);
}
