// Route state: every known route by id, kept in sync from the REST snapshot and live WebSocket route events.
// Data flow: store action → applyRoutesSnapshot() / applyRouteMessage() → new Routes → store → UI.
// Rule: an incoming route replaces ours only if its `_version` is newer (QUIRK #4 optimistic-lock version), so old or
// duplicate events never overwrite newer data. Pure functions: no I/O, no store, no React.
import type { WsServerMessage } from './events';
import type { Route } from './models';

export type Routes = Readonly<Record<string, Route>>;

// The WS messages that carry a route change.
export type RouteMessage = Extract<WsServerMessage, { type: 'route_assigned' | 'route_updated' | 'route_reassigned' }>;

export function isRouteMessage(message: WsServerMessage): message is RouteMessage {
  return message.type === 'route_assigned' || message.type === 'route_updated' || message.type === 'route_reassigned';
}

function isNewer(incoming: Route, existing: Route | undefined): boolean {
  return existing === undefined || incoming._version > existing._version;
}

// Returns the SAME object when the incoming route is not newer (no redraw).
export function upsertRoute(routes: Routes, incoming: Route): Routes {
  if (!isNewer(incoming, routes[incoming.id])) {
    return routes;
  }
  return { ...routes, [incoming.id]: incoming };
}

// GET /api/routes. The server's list is the source of truth for which routes exist, but a route we already hold
// with a newer version (a WS event that arrived while the request was in flight) is kept.
export function applyRoutesSnapshot(routes: Routes, snapshot: readonly Route[]): Routes {
  const next: Record<string, Route> = {};
  for (const incoming of snapshot) {
    const existing = routes[incoming.id];
    next[incoming.id] = existing !== undefined && existing._version > incoming._version ? existing : incoming;
  }
  return next;
}

export function applyRouteMessage(routes: Routes, message: RouteMessage): Routes {
  return upsertRoute(routes, message.route);
}

// A route that is finished frees its truck (server: completed / cancelled → truck.currentRouteId = null).
export function isFinished(route: Route): boolean {
  return route.status === 'completed' || route.status === 'cancelled';
}
