// Feature: Route texts the dispatcher reads (audit log lines, conflict "what", button labels)
// Tests:   src/ui/routeFormat.ts
// Rule:    unknown values say so honestly ("an unknown truck", "another dispatcher"); our own id reads "You";
//          only final actions (complete, cancel) need confirmation.
import { describe, expect, it } from 'vitest';
import { FleetResponseSchema } from '../../src/domain/api';
import { applyFleetSnapshot } from '../../src/domain/fleet';
import { describeAuditAction, dispatcherLabel, needsConfirmation, statusActionLabel } from '../../src/ui/routeFormat';
import fleetFixture from '../../fixtures/rest/fleet_200.json';

const response = FleetResponseSchema.parse(fleetFixture.body);
const trucks = applyFleetSnapshot({}, response.fleet, response.timestamp);

describe('Route texts', () => {
  it('dispatcher label: "You" for us, the id for others, "another dispatcher" when unknown', () => {
    expect(dispatcherLabel('d1', 'd1')).toBe('You');
    expect(dispatcherLabel('d2', 'd1')).toBe('d2');
    expect(dispatcherLabel(null, 'd1')).toBe('another dispatcher');
  });

  it('audit actions read as sentences with truck names', () => {
    expect(describeAuditAction({ kind: 'reassigned', fromTruckId: 'truck_1', toTruckId: 'truck_4' }, trucks)).toBe(
      'reassigned it Truck Alpha → Truck Delta',
    );
    expect(describeAuditAction({ kind: 'assigned', truckId: 'truck_1', destination: 'Port' }, trucks)).toBe(
      'assigned the route to Truck Alpha ("Port")',
    );
    expect(describeAuditAction({ kind: 'updated', status: { from: 'assigned', to: 'in-progress' }, notesChanged: false }, trucks)).toBe(
      'changed status assigned → in-progress',
    );
  });

  it('unknown "from" values are left out rather than invented', () => {
    expect(describeAuditAction({ kind: 'reassigned', fromTruckId: null, toTruckId: 'truck_4' }, trucks)).toBe('reassigned it Truck Delta');
    expect(describeAuditAction({ kind: 'updated', status: { from: null, to: 'completed' }, notesChanged: false }, trucks)).toBe(
      'changed status → completed',
    );
  });

  it('buttons and confirmations', () => {
    expect(statusActionLabel('in-progress')).toBe('Start');
    expect(needsConfirmation('in-progress')).toBe(false);
    expect(needsConfirmation('completed')).toBe(true);
    expect(needsConfirmation('cancelled')).toBe(true);
  });
});
