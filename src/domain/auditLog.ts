// Route audit log (the server has none): who changed which route, how, and when.
// Data flow: WS route event → store.applyRouteMessage → auditEntryFromMessage(previous route, event) → addAuditEntries;
// routes snapshot → auditEntriesFromSnapshot → addAuditEntries (seeds history from before this tab opened).
// Bounded to MAX_AUDIT_ENTRIES. Pure functions: no I/O, no store, no React.
import type { Route, RoutePriority, RouteStatus } from './models';
import type { RouteMessage } from './routes';

export const MAX_AUDIT_ENTRIES: number = 200;

export interface FieldChange<T> {
  // null = not known (the change happened before this tab opened).
  from: T | null;
  to: T;
}

export type AuditAction =
  // truckId null = not known (snapshot of a route that was reassigned since).
  | { kind: 'assigned'; truckId: string | null; destination: string }
  | { kind: 'updated'; status?: FieldChange<RouteStatus>; priority?: FieldChange<RoutePriority>; notesChanged: boolean }
  | { kind: 'reassigned'; fromTruckId: string | null; toTruckId: string };

export interface AuditEntry {
  // route + kind + server time of the change: the same change from a live event or a snapshot gets the same key.
  key: string;
  at: number;
  routeId: string;
  by: string;
  version: number | null;
  action: AuditAction;
  source: 'live' | 'snapshot';
}

export type AuditLog = readonly AuditEntry[];

function entryKey(routeId: string, kind: AuditAction['kind'], at: number): string {
  return `${routeId}:${kind}:${at}`;
}

// What changed in a route_updated, compared with the version we held before (null = unknown).
function describeUpdate(previous: Route | undefined, route: Route): AuditAction {
  const action: Extract<AuditAction, { kind: 'updated' }> = { kind: 'updated', notesChanged: false };
  if (previous === undefined || previous.status !== route.status) {
    action.status = { from: previous?.status ?? null, to: route.status };
  }
  if (previous !== undefined && previous.priority !== route.priority) {
    action.priority = { from: previous.priority, to: route.priority };
  }
  action.notesChanged = previous !== undefined && previous.notes !== route.notes;
  return action;
}

// `previous` = our copy of the route before this event was applied.
export function auditEntryFromMessage(previous: Route | undefined, message: RouteMessage): AuditEntry {
  const route = message.route;
  if (message.type === 'route_assigned') {
    return {
      key: entryKey(route.id, 'assigned', route.assignedAt),
      at: route.assignedAt,
      routeId: route.id,
      by: message.assignedBy,
      version: route._version,
      action: { kind: 'assigned', truckId: route.truckId, destination: route.destination },
      source: 'live',
    };
  }
  if (message.type === 'route_reassigned') {
    const at = route.reassignedAt ?? message.timestamp;
    return {
      key: entryKey(route.id, 'reassigned', at),
      at,
      routeId: route.id,
      by: message.reassignedBy,
      version: route._version,
      action: { kind: 'reassigned', fromTruckId: message.oldTruckId ?? null, toTruckId: message.newTruckId },
      source: 'live',
    };
  }
  const at = route.lastModifiedAt ?? message.timestamp;
  return {
    key: entryKey(route.id, 'updated', at),
    at,
    routeId: route.id,
    by: message.updatedBy,
    version: route._version,
    action: describeUpdate(previous, route),
    source: 'live',
  };
}

// The truck a route was first assigned to: the current one, unless it was reassigned since (then unknown).
function firstTruckFromSnapshot(route: Route): string | null {
  return route.reassignedBy === undefined ? route.truckId : null;
}

// From each route we only know the latest change of each kind (and not the previous values).
export function auditEntriesFromSnapshot(routes: readonly Route[]): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const route of routes) {
    entries.push({
      key: entryKey(route.id, 'assigned', route.assignedAt),
      at: route.assignedAt,
      routeId: route.id,
      by: route.assignedBy,
      version: null,
      action: { kind: 'assigned', truckId: firstTruckFromSnapshot(route), destination: route.destination },
      source: 'snapshot',
    });
    if (route.reassignedBy !== undefined && route.reassignedAt !== undefined) {
      entries.push({
        key: entryKey(route.id, 'reassigned', route.reassignedAt),
        at: route.reassignedAt,
        routeId: route.id,
        by: route.reassignedBy,
        version: null,
        action: { kind: 'reassigned', fromTruckId: null, toTruckId: route.truckId },
        source: 'snapshot',
      });
    }
    if (route.lastModifiedBy !== undefined && route.lastModifiedAt !== undefined) {
      entries.push({
        key: entryKey(route.id, 'updated', route.lastModifiedAt),
        at: route.lastModifiedAt,
        routeId: route.id,
        by: route.lastModifiedBy,
        version: null,
        action: { kind: 'updated', status: { from: null, to: route.status }, notesChanged: false },
        source: 'snapshot',
      });
    }
  }
  return entries;
}

// Adds entries: skips keys we already have (live wins over snapshot), keeps the log sorted by time (oldest first),
// and drops the oldest beyond MAX_AUDIT_ENTRIES. Returns the SAME array when nothing was added.
export function addAuditEntries(log: AuditLog, entries: readonly AuditEntry[]): AuditLog {
  const known = new Set(log.map((entry) => entry.key));
  const fresh: AuditEntry[] = [];
  for (const entry of entries) {
    if (!known.has(entry.key)) {
      known.add(entry.key);
      fresh.push(entry);
    }
  }
  if (fresh.length === 0) return log;
  const merged = [...log, ...fresh].sort((a, b) => a.at - b.at);
  return merged.length > MAX_AUDIT_ENTRIES ? merged.slice(merged.length - MAX_AUDIT_ENTRIES) : merged;
}
