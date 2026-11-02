// Feature: Route audit log (client-side — the server has no audit endpoint)
// Tests:   src/domain/auditLog.ts → auditEntryFromMessage(), auditEntriesFromSnapshot(), addAuditEntries()
// Rule:    every route event becomes a who/what/when entry; the routes snapshot seeds older history; the same change
//          from a live event or a (re)loaded snapshot never appears twice; the log is time-sorted and bounded.
import { describe, expect, it } from 'vitest';
import { RoutesResponseSchema } from '../../src/domain/api';
import {
  addAuditEntries,
  auditEntriesFromSnapshot,
  auditEntryFromMessage,
  MAX_AUDIT_ENTRIES,
  type AuditEntry,
} from '../../src/domain/auditLog';
import { WsServerMessageSchema } from '../../src/domain/events';
import { isRouteMessage, type RouteMessage } from '../../src/domain/routes';
import routesFixture from '../../fixtures/rest/routes.json';
import assignedFixture from '../../fixtures/ws/route_assigned.json';
import reassignedFixture from '../../fixtures/ws/route_reassigned.json';
import updatedFixture from '../../fixtures/ws/route_updated.json';

function routeMessage(raw: unknown): RouteMessage {
  const message = WsServerMessageSchema.parse(raw);
  if (!isRouteMessage(message)) throw new Error('not a route message');
  return message;
}

const assigned = routeMessage(assignedFixture);
const reassigned = routeMessage(reassignedFixture);
const updated = routeMessage(updatedFixture);
const snapshotRoutes = RoutesResponseSchema.parse(routesFixture.body).routes;

describe('Audit log — live events', () => {
  it('assigned → who, which truck, destination', () => {
    const entry = auditEntryFromMessage(undefined, assigned);
    expect(entry).toMatchObject({
      routeId: 'route_1',
      by: assigned.route.assignedBy,
      source: 'live',
      action: { kind: 'assigned', truckId: assigned.route.truckId, destination: assigned.route.destination },
    });
  });

  it('reassigned → from which truck to which', () => {
    if (reassigned.type !== 'route_reassigned') throw new Error('fixture');
    const entry = auditEntryFromMessage(assigned.route, reassigned);
    expect(entry.action).toEqual({ kind: 'reassigned', fromTruckId: reassigned.oldTruckId, toTruckId: reassigned.newTruckId });
    expect(entry.by).toBe(reassigned.reassignedBy);
  });

  it('updated → status change from the version we held before', () => {
    const entry = auditEntryFromMessage(reassigned.route, updated);
    expect(entry.action).toEqual({ kind: 'updated', status: { from: 'assigned', to: 'in-progress' }, notesChanged: false });
  });

  it('updated with no previous copy → status "from" is unknown (null)', () => {
    const entry = auditEntryFromMessage(undefined, updated);
    expect(entry.action).toMatchObject({ kind: 'updated', status: { from: null, to: 'in-progress' } });
  });
});

describe('Audit log — snapshot seeding and de-duplication', () => {
  it('a snapshot route that was assigned, reassigned and modified gives 3 entries', () => {
    const entries = auditEntriesFromSnapshot(snapshotRoutes);
    expect(entries.map((entry) => entry.action.kind)).toEqual(['assigned', 'reassigned', 'updated']);
    expect(entries.every((entry) => entry.source === 'snapshot')).toBe(true);
    // Reassigned since → the first truck is not known.
    expect(entries[0]?.action).toMatchObject({ kind: 'assigned', truckId: null });
  });

  it('the same change from a live event and from a later snapshot appears only once (live kept)', () => {
    let log = addAuditEntries([], [auditEntryFromMessage(undefined, assigned)]);
    log = addAuditEntries(log, [auditEntryFromMessage(assigned.route, reassigned)]);
    log = addAuditEntries(log, [auditEntryFromMessage(reassigned.route, updated)]);
    const after = addAuditEntries(log, auditEntriesFromSnapshot(snapshotRoutes));
    expect(after).toBe(log);
    expect(after.every((entry) => entry.source === 'live')).toBe(true);
  });

  it('reloading the same snapshot adds nothing (SAME array)', () => {
    const log = addAuditEntries([], auditEntriesFromSnapshot(snapshotRoutes));
    expect(addAuditEntries(log, auditEntriesFromSnapshot(snapshotRoutes))).toBe(log);
  });
});

describe('Audit log — order and bound', () => {
  function entryAt(at: number): AuditEntry {
    return {
      key: `route_x:updated:${at}`,
      at,
      routeId: 'route_x',
      by: 'dispatcher_a',
      version: null,
      action: { kind: 'updated', notesChanged: true },
      source: 'live',
    };
  }

  it('entries are sorted by time even if they arrive out of order', () => {
    const log = addAuditEntries([], [entryAt(3000), entryAt(1000), entryAt(2000)]);
    expect(log.map((entry) => entry.at)).toEqual([1000, 2000, 3000]);
  });

  it(`keeps at most ${MAX_AUDIT_ENTRIES} entries — the oldest are dropped`, () => {
    const many: AuditEntry[] = [];
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 50; i++) many.push(entryAt(i));
    const log = addAuditEntries([], many);
    expect(log).toHaveLength(MAX_AUDIT_ENTRIES);
    expect(log[0]?.at).toBe(50);
  });
});
