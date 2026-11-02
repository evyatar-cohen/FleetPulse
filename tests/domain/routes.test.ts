// Feature: Route state (REST snapshot + live WS route events, ordered by version)
// Tests:   src/domain/routes.ts → applyRoutesSnapshot(), applyRouteMessage();
//          src/domain/fleet.ts → applyRouteMessageToTrucks()
// Rule:    an incoming route replaces ours only if its `_version` is newer; route events keep each truck's
//          currentRouteId in step (assign → set, complete/cancel → clear, reassign → move).
import { describe, expect, it } from 'vitest';
import { RoutesResponseSchema } from '../../src/domain/api';
import { WsServerMessageSchema } from '../../src/domain/events';
import { applyFleetSnapshot, applyRouteMessageToTrucks, type Trucks } from '../../src/domain/fleet';
import { FleetResponseSchema } from '../../src/domain/api';
import { applyRouteMessage, applyRoutesSnapshot, type RouteMessage, type Routes } from '../../src/domain/routes';
import fleetFixture from '../../fixtures/rest/fleet_200.json';
import routesFixture from '../../fixtures/rest/routes.json';
import assignedFixture from '../../fixtures/ws/route_assigned.json';
import reassignedFixture from '../../fixtures/ws/route_reassigned.json';
import updatedFixture from '../../fixtures/ws/route_updated.json';

function routeMessage(raw: unknown): RouteMessage {
  const message = WsServerMessageSchema.parse(raw);
  if (message.type !== 'route_assigned' && message.type !== 'route_updated' && message.type !== 'route_reassigned') {
    throw new Error(`not a route message: ${message.type}`);
  }
  return message;
}

const assigned = routeMessage(assignedFixture);
const reassigned = routeMessage(reassignedFixture);
const updated = routeMessage(updatedFixture);

function fleet(): Trucks {
  const response = FleetResponseSchema.parse(fleetFixture.body);
  return applyFleetSnapshot({}, response.fleet, response.timestamp);
}

describe('Route state — versions', () => {
  it('a new route is added', () => {
    const routes = applyRouteMessage({}, assigned);
    expect(routes['route_1']?._version).toBe(1);
  });

  it('a newer version replaces the older one (assigned v1 → reassigned v2 → updated v3)', () => {
    let routes: Routes = {};
    routes = applyRouteMessage(routes, assigned);
    routes = applyRouteMessage(routes, reassigned);
    routes = applyRouteMessage(routes, updated);
    expect(routes['route_1']?._version).toBe(3);
    expect(routes['route_1']?.status).toBe('in-progress');
  });

  it('an older or duplicate event arriving late changes nothing (SAME object)', () => {
    const latest = applyRouteMessage(applyRouteMessage({}, assigned), updated);
    expect(applyRouteMessage(latest, reassigned)).toBe(latest);
    expect(applyRouteMessage(latest, updated)).toBe(latest);
  });

  it('snapshot: the server list decides which routes exist, but a newer local version is kept', () => {
    const snapshot = RoutesResponseSchema.parse(routesFixture.body).routes;
    const local = applyRouteMessage({}, { ...updated, route: { ...updated.route, _version: 99 } });
    const merged = applyRoutesSnapshot(local, snapshot);
    expect(merged['route_1']?._version).toBe(99);
    expect(applyRoutesSnapshot(local, [])).toEqual({});
  });
});

describe('Route events → trucks', () => {
  it('assigned → the truck gets the route id', () => {
    const trucks = applyRouteMessageToTrucks(fleet(), assigned);
    expect(trucks[assigned.route.truckId]?.currentRouteId).toBe('route_1');
  });

  it('reassigned → the route moves from the old truck to the new one', () => {
    const withRoute = applyRouteMessageToTrucks(fleet(), assigned);
    if (reassigned.type !== 'route_reassigned') throw new Error('fixture');
    const trucks = applyRouteMessageToTrucks(withRoute, reassigned);
    expect(trucks[reassigned.oldTruckId ?? '']?.currentRouteId).toBeNull();
    expect(trucks[reassigned.newTruckId]?.currentRouteId).toBe('route_1');
  });

  it('completed or cancelled → the truck is freed', () => {
    const withRoute = applyRouteMessageToTrucks(fleet(), assigned);
    const truckId = assigned.route.truckId;
    const completed = routeMessage({ ...updatedFixture, route: { ...updatedFixture.route, truckId, status: 'completed' } });
    expect(applyRouteMessageToTrucks(withRoute, completed)[truckId]?.currentRouteId).toBeNull();
  });

  it('a status change that does not finish the route leaves trucks unchanged (SAME object)', () => {
    const trucks = fleet();
    expect(applyRouteMessageToTrucks(trucks, updated)).toBe(trucks);
  });
});
