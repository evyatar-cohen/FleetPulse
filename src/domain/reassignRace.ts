// Reassign race helpers. PUT /api/routes/:id/reassign has NO version check on the server (two dispatchers can both
// reassign; the last one silently wins), so the client narrows the window and makes clashes visible:
//   before sending → changedSinceOpened(): did the route move since the dialog opened?
//   after sending  → findConcurrentReassign(): did someone else reassign it at about the same time?
// Pure functions over the route state and the audit log.
import type { AuditAction, AuditEntry, AuditLog } from './auditLog';
import type { Route } from './models';

export const REASSIGN_RACE_WINDOW_MS: number = 5000;

export interface RouteChangeInfo {
  by: string | null;
  change: AuditAction | null;
}

// The newest audit entry for this route (any version newer than `afterVersion`).
function newestEntryAfter(log: AuditLog, routeId: string, afterVersion: number): AuditEntry | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry !== undefined && entry.routeId === routeId && entry.version !== null && entry.version > afterVersion) {
      return entry;
    }
  }
  return undefined;
}

// null = unchanged since the dialog opened (at `openedVersion`); otherwise who changed it and how (if known).
export function changedSinceOpened(route: Route | undefined, openedVersion: number, log: AuditLog): RouteChangeInfo | null {
  if (route === undefined || route._version === openedVersion) {
    return null;
  }
  const entry = newestEntryAfter(log, route.id, openedVersion);
  if (entry === undefined) {
    return { by: null, change: null };
  }
  return { by: entry.by, change: entry.action };
}

// Another dispatcher's reassign of the same route within ±window of ours, or null.
export function findConcurrentReassign(
  log: AuditLog,
  routeId: string,
  myDispatcherId: string,
  myReassignAt: number,
  windowMs: number = REASSIGN_RACE_WINDOW_MS,
): AuditEntry | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (
      entry !== undefined &&
      entry.routeId === routeId &&
      entry.action.kind === 'reassigned' &&
      entry.by !== myDispatcherId &&
      Math.abs(entry.at - myReassignAt) <= windowMs
    ) {
      return entry;
    }
  }
  return null;
}
