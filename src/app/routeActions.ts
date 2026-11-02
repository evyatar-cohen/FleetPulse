// Route actions the UI calls: create, update status, apply-mine-after-conflict, reassign.
// Data flow: UI → action → client rules (domain/routeRules) → REST (one request, no automatic retry — writes aren't
// idempotent) → outcome back to the UI. The new route data itself arrives via the WS event (the server broadcasts it
// just before answering), so actions never write routes into the store — one source of truth, complete audit log.
import type { AuditAction } from '../domain/auditLog';
import { describeConflict, type AttemptedChange, type ConflictDescription } from '../domain/conflicts';
import type { RouteStatus } from '../domain/models';
import { changedSinceOpened } from '../domain/reassignRace';
import {
  canTransition,
  validateNewRoute,
  validateReassign,
  type FieldErrors,
  type NewRouteDraft,
} from '../domain/routeRules';
import type { ApiError, RestClient } from '../transport/restClient';
import { withRetry } from '../transport/retry';
import type { StoreAccess } from './startup';

export type Conflict = Extract<ConflictDescription, { kind: 'conflict' }>;

export type ActionOutcome =
  // `reassignedAt`: server time of our reassign — the UI watches for a concurrent one around it (D44).
  | { kind: 'success'; reassignedAt?: number }
  // Reassign only: the route changed since the dialog opened (no server lock) — confirm again to continue.
  | { kind: 'changed_since_opened'; by: string | null; change: AuditAction | null }
  // Our own earlier attempt (e.g. a timed-out request) had already made this change.
  | { kind: 'already_applied' }
  // Someone else changed the route first (409). `attempt` is what we tried, for "apply mine".
  | { kind: 'conflict'; conflict: Conflict; attempt: AttemptedChange }
  // POST /api/routes 409: the truck already has a route.
  | { kind: 'truck_taken'; routeId: string; by: string | null; byMe: boolean }
  // Our own rules said no — nothing was sent.
  | { kind: 'invalid'; errors: FieldErrors | string }
  // Network/timeout (retryable: the dispatcher may press Retry) or a server error.
  | { kind: 'error'; message: string; retryable: boolean };

export interface RouteActions {
  createRoute: (draft: NewRouteDraft) => Promise<ActionOutcome>;
  updateStatus: (routeId: string, status: RouteStatus) => Promise<ActionOutcome>;
  // After a conflict: resend our change based on the route's CURRENT version (the dispatcher chose "apply mine").
  applyMine: (attempt: AttemptedChange, currentVersion: number) => Promise<ActionOutcome>;
  // `openedVersion`: the route version when the dialog opened. `confirmedDespiteChange`: the dispatcher saw the
  // "changed since opened" warning and chose to continue.
  reassign: (routeId: string, newTruckId: string, openedVersion: number, confirmedDespiteChange?: boolean) => Promise<ActionOutcome>;
}

function errorOutcome(error: ApiError): ActionOutcome {
  switch (error.kind) {
    case 'network':
    case 'timeout':
      // The request may or may not have reached the server — only the dispatcher can decide to retry.
      return { kind: 'error', message: 'No answer from the server. The change may or may not have been saved.', retryable: true };
    case 'not_registered':
      return { kind: 'error', message: 'Still connecting to dispatch — try again in a moment.', retryable: true };
    case 'target_truck_busy':
    case 'bad_request':
    case 'not_found':
    case 'unauthorized':
      return { kind: 'error', message: error.message, retryable: false };
    default:
      return { kind: 'error', message: `Unexpected server answer (${error.kind}).`, retryable: false };
  }
}

export function createRouteActions(rest: RestClient, store: StoreAccess): RouteActions {
  async function reloadRoutes(): Promise<void> {
    const result = await withRetry(() => rest.getRoutes());
    if (result.ok) store.getState().applyRoutesResponse(result.data.routes);
  }

  async function sendUpdate(attempt: AttemptedChange): Promise<ActionOutcome> {
    const result = await rest.updateRoute(attempt.routeId, attempt.changes, attempt.expectedVersion);
    if (result.ok) return { kind: 'success' };
    if (result.error.kind !== 'version_conflict') return errorOutcome(result.error);

    // QUIRK #4 / #8: describe who and what. If unknown yet, reload routes ONCE and describe again.
    const body = result.error.body;
    const context = () => ({
      routes: store.getState().routes,
      auditLog: store.getState().auditLog,
      myDispatcherId: store.getState().dispatcherId,
    });
    let described = describeConflict(attempt, body, context());
    if (described.kind === 'needs_refresh') {
      await reloadRoutes();
      described = describeConflict(attempt, body, context(), { afterRefresh: true });
    }
    if (described.kind === 'already_applied') return { kind: 'already_applied' };
    if (described.kind === 'needs_refresh') {
      return { kind: 'error', message: 'The route was changed by someone else.', retryable: false };
    }
    return { kind: 'conflict', conflict: described, attempt };
  }

  return {
    async createRoute(draft) {
      const valid = validateNewRoute(draft, store.getState().trucks);
      if (!valid.ok) return { kind: 'invalid', errors: valid.error };

      const result = await rest.createRoute(valid.data);
      if (result.ok) return { kind: 'success' };
      if (result.error.kind === 'truck_assigned') {
        const by = result.error.body.assignedBy ?? null;
        return { kind: 'truck_taken', routeId: result.error.body.currentRouteId, by, byMe: by !== null && by === store.getState().dispatcherId };
      }
      return errorOutcome(result.error);
    },

    async updateStatus(routeId, status) {
      const route = store.getState().routes[routeId];
      if (route === undefined) return { kind: 'invalid', errors: 'Route not found' };
      // E.g. a manual Retry after a timeout whose first attempt actually worked: nothing to do.
      if (route.status === status) return { kind: 'already_applied' };
      if (!canTransition(route.status, status)) {
        return { kind: 'invalid', errors: `Cannot change a ${route.status} route to ${status}` };
      }
      // QUIRK #4: always send the version we saw — without If-Match the server would overwrite blindly.
      return sendUpdate({ routeId, expectedVersion: route._version, changes: { status } });
    },

    async applyMine(attempt, currentVersion) {
      const route = store.getState().routes[attempt.routeId];
      const status = attempt.changes.status;
      if (route !== undefined && status !== undefined && route.status === status) return { kind: 'already_applied' };
      if (route !== undefined && status !== undefined && !canTransition(route.status, status)) {
        return { kind: 'invalid', errors: `Cannot change a ${route.status} route to ${status}` };
      }
      return sendUpdate({ ...attempt, expectedVersion: currentVersion });
    },

    async reassign(routeId, newTruckId, openedVersion, confirmedDespiteChange = false) {
      const state = store.getState();
      const route = state.routes[routeId];
      if (route === undefined) return { kind: 'invalid', errors: 'Route not found' };
      const valid = validateReassign(route, newTruckId, state.trucks);
      if (!valid.ok) return { kind: 'invalid', errors: valid.error };

      // No version check on the server for reassign: our own check is the only guard against overwriting a change.
      const changed = changedSinceOpened(route, openedVersion, state.auditLog);
      if (changed !== null && !confirmedDespiteChange) {
        return { kind: 'changed_since_opened', by: changed.by, change: changed.change };
      }

      const result = await rest.reassignRoute(routeId, newTruckId);
      if (!result.ok) return errorOutcome(result.error);
      return { kind: 'success', reassignedAt: result.data.reassignedAt };
    },
  };
}
