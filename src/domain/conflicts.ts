// Turns a 409 on a route update into what the dispatcher needs: WHO changed the route, WHAT they changed, and what
// can be done now. Data flow: route action gets `version_conflict` → describeConflict(attempt, 409 body, store data)
// → UI conflict dialog. Pure functions.
//
// QUIRK #4 / #8: the immediate 409 has `lastModifiedBy`, the delayed one has no "who" at all — and the server fills
// `lastModifiedBy` with `route.lastModifiedBy || route.assignedBy`, so after a reassign it names the route's CREATOR.
// That's why the body is the LAST source we trust.
import type { RouteConflictBody } from './api';
import type { AuditAction, AuditEntry, AuditLog } from './auditLog';
import type { Route, RoutePriority, RouteStatus } from './models';
import { canTransition } from './routeRules';
import type { Routes } from './routes';

export interface RouteChangeDraft {
  status?: RouteStatus;
  priority?: RoutePriority;
  notes?: string;
}

// What we tried: the change and the version we based it on (sent as If-Match).
export interface AttemptedChange {
  routeId: string;
  expectedVersion: number;
  changes: RouteChangeDraft;
}

export interface ConflictContext {
  routes: Routes;
  auditLog: AuditLog;
  myDispatcherId: string | null;
}

export type WhoSource = 'audit' | 'route' | 'server' | 'unknown';

export type ConflictDescription =
  // We don't know who yet (the WS event hasn't arrived): reload routes once, then describe again.
  | { kind: 'needs_refresh'; currentVersion: number }
  // The change that beat us was our own earlier attempt (e.g. a retry after a timeout) — it already worked.
  | { kind: 'already_applied'; currentVersion: number }
  | {
      kind: 'conflict';
      currentVersion: number;
      who: string | null;
      whoSource: WhoSource;
      // What they changed — known only from the audit log.
      theirChange: AuditAction | null;
      // The route as it is now — undefined if we don't hold that version.
      currentRoute: Route | undefined;
      // Can our change still be applied on top of theirs (resent with the new version)?
      canApplyMine: boolean;
    };

// The audit entry of exactly this version of the route = the change that beat us. Newest entries are at the end.
function findEntryForVersion(log: AuditLog, routeId: string, version: number): AuditEntry | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry !== undefined && entry.routeId === routeId && entry.version === version) {
      return entry;
    }
  }
  return undefined;
}

// Who made the latest change to this route: the newer of the last update and the last reassign.
function lastChangedBy(route: Route): string {
  const reassignIsNewer =
    route.reassignedAt !== undefined && (route.lastModifiedAt === undefined || route.reassignedAt > route.lastModifiedAt);
  if (reassignIsNewer && route.reassignedBy !== undefined) return route.reassignedBy;
  if (route.lastModifiedBy !== undefined) return route.lastModifiedBy;
  return route.assignedBy;
}

// Does the route already have every value we wanted to set?
function routeHasChanges(route: Route, changes: RouteChangeDraft): boolean {
  if (changes.status !== undefined && route.status !== changes.status) return false;
  if (changes.priority !== undefined && route.priority !== changes.priority) return false;
  if (changes.notes !== undefined && route.notes !== changes.notes) return false;
  return true;
}

// Only if we hold the current version (otherwise we can't know it's safe) and the transition is still allowed.
function canApplyChanges(currentRoute: Route | undefined, changes: RouteChangeDraft): boolean {
  if (currentRoute === undefined) return false;
  if (changes.status === undefined) return currentRoute.status !== 'completed' && currentRoute.status !== 'cancelled';
  return canTransition(currentRoute.status, changes.status);
}

interface WhoAndWhat {
  who: string | null;
  whoSource: WhoSource;
  theirChange: AuditAction | null;
}

// Most reliable source first: the audit log entry → our stored route → the 409 body.
function findWhoAndWhat(
  attempt: AttemptedChange,
  body: RouteConflictBody,
  context: ConflictContext,
  currentRoute: Route | undefined,
): WhoAndWhat | null {
  const entry = findEntryForVersion(context.auditLog, attempt.routeId, body.currentVersion);
  if (entry !== undefined) {
    return { who: entry.by, whoSource: 'audit', theirChange: entry.action };
  }
  if (currentRoute !== undefined) {
    return { who: lastChangedBy(currentRoute), whoSource: 'route', theirChange: null };
  }
  if (body.lastModifiedBy !== undefined) {
    return { who: body.lastModifiedBy, whoSource: 'server', theirChange: null };
  }
  return null;
}

export function describeConflict(
  attempt: AttemptedChange,
  body: RouteConflictBody,
  context: ConflictContext,
  options: { afterRefresh: boolean } = { afterRefresh: false },
): ConflictDescription {
  const currentVersion = body.currentVersion;
  const stored = context.routes[attempt.routeId];
  const currentRoute = stored !== undefined && stored._version === currentVersion ? stored : undefined;

  const found = findWhoAndWhat(attempt, body, context, currentRoute);
  if (found === null && !options.afterRefresh) {
    return { kind: 'needs_refresh', currentVersion };
  }
  const { who, whoSource, theirChange } = found ?? { who: null, whoSource: 'unknown', theirChange: null };

  const wasMe = who !== null && who === context.myDispatcherId;
  if (wasMe && currentRoute !== undefined && routeHasChanges(currentRoute, attempt.changes)) {
    return { kind: 'already_applied', currentVersion };
  }

  return {
    kind: 'conflict',
    currentVersion,
    who,
    whoSource,
    theirChange,
    currentRoute,
    canApplyMine: canApplyChanges(currentRoute, attempt.changes),
  };
}
