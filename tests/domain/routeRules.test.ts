// Feature: Route business rules (the server accepts anything — the client validates)
// Tests:   src/domain/routeRules.ts → canTransition(), allowedNextStatuses(), validateNewRoute(), validateReassign()
// Rule:    assigned → in-progress | cancelled; in-progress → completed | cancelled; completed/cancelled are final.
//          New route / reassign: valid input, and the target truck exists, has no route and is not in maintenance.
import { describe, expect, it } from 'vitest';
import { FleetResponseSchema, RoutesResponseSchema } from '../../src/domain/api';
import { applyFleetSnapshot, type Trucks } from '../../src/domain/fleet';
import type { RouteStatus } from '../../src/domain/models';
import {
  allowedNextStatuses,
  canTransition,
  DESTINATION_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  validateNewRoute,
  validateReassign,
} from '../../src/domain/routeRules';
import fleetFixture from '../../fixtures/rest/fleet_200.json';
import routesFixture from '../../fixtures/rest/routes.json';

const response = FleetResponseSchema.parse(fleetFixture.body);
const route = RoutesResponseSchema.parse(routesFixture.body).routes[0];

// truck_7 is in maintenance in the fixture; give truck_3 a route.
function trucks(): Trucks {
  const loaded = applyFleetSnapshot({}, response.fleet, response.timestamp);
  const truck3 = loaded['truck_3'];
  if (truck3 === undefined) throw new Error('fixture');
  return { ...loaded, truck_3: { ...truck3, currentRouteId: 'route_9' } };
}

describe('Status transitions', () => {
  const allowed: Array<[RouteStatus, RouteStatus]> = [
    ['assigned', 'in-progress'],
    ['assigned', 'cancelled'],
    ['in-progress', 'completed'],
    ['in-progress', 'cancelled'],
  ];
  it.each(allowed)('%s → %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  const blocked: Array<[RouteStatus, RouteStatus]> = [
    ['assigned', 'completed'],
    ['in-progress', 'assigned'],
    ['completed', 'in-progress'],
    ['cancelled', 'assigned'],
    ['assigned', 'assigned'],
  ];
  it.each(blocked)('%s → %s is blocked', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('completed and cancelled are final', () => {
    expect(allowedNextStatuses('completed')).toEqual([]);
    expect(allowedNextStatuses('cancelled')).toEqual([]);
  });
});

describe('New route validation', () => {
  it('valid input is trimmed and gets defaults', () => {
    const result = validateNewRoute({ truckId: 'truck_1', destination: '  Haifa Port  ' }, trucks());
    expect(result).toEqual({ ok: true, data: { truckId: 'truck_1', destination: 'Haifa Port', priority: 'normal', notes: '' } });
  });

  it('destination too short, too long, or only spaces → field error', () => {
    expect(validateNewRoute({ truckId: 'truck_1', destination: '   ' }, trucks())).toMatchObject({ ok: false, error: { destination: expect.any(String) } });
    expect(validateNewRoute({ truckId: 'truck_1', destination: 'ab' }, trucks()).ok).toBe(false);
    expect(validateNewRoute({ truckId: 'truck_1', destination: 'x'.repeat(DESTINATION_MAX_LENGTH + 1) }, trucks()).ok).toBe(false);
  });

  it('notes too long → field error', () => {
    const result = validateNewRoute({ truckId: 'truck_1', destination: 'Haifa', notes: 'n'.repeat(NOTES_MAX_LENGTH + 1) }, trucks());
    expect(result).toMatchObject({ ok: false, error: { notes: expect.any(String) } });
  });

  it('truck in maintenance → blocked (the server would allow it)', () => {
    expect(validateNewRoute({ truckId: 'truck_7', destination: 'Haifa' }, trucks())).toMatchObject({
      ok: false,
      error: { truckId: 'Truck is in maintenance' },
    });
  });

  it('truck that already has a route, or unknown truck → blocked', () => {
    expect(validateNewRoute({ truckId: 'truck_3', destination: 'Haifa' }, trucks())).toMatchObject({ error: { truckId: 'Truck already has a route' } });
    expect(validateNewRoute({ truckId: 'truck_99', destination: 'Haifa' }, trucks())).toMatchObject({ error: { truckId: 'Truck not found' } });
  });

  it('several problems are all reported at once', () => {
    const result = validateNewRoute({ truckId: 'truck_7', destination: '' }, trucks());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.error).sort()).toEqual(['destination', 'truckId']);
  });
});

describe('Reassign validation', () => {
  if (route === undefined) throw new Error('fixture');

  it('a free, working truck → allowed', () => {
    expect(validateReassign(route, 'truck_1', trucks())).toEqual({ ok: true, data: null });
  });

  it('same truck, busy truck, maintenance truck → blocked', () => {
    expect(validateReassign(route, route.truckId, trucks()).ok).toBe(false);
    expect(validateReassign(route, 'truck_3', trucks())).toEqual({ ok: false, error: 'Truck already has a route' });
    expect(validateReassign(route, 'truck_7', trucks())).toEqual({ ok: false, error: 'Truck is in maintenance' });
  });

  it('a finished route cannot be reassigned', () => {
    expect(validateReassign({ ...route, status: 'completed' }, 'truck_1', trucks())).toEqual({ ok: false, error: 'Route is completed' });
  });
});
