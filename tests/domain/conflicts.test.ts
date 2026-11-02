// Feature: Describing a 409 conflict (QUIRK #4 immediate 409, QUIRK #8 delayed 409 without "who")
// Tests:   src/domain/conflicts.ts → describeConflict()
// Rule:    "who/what" comes from the audit log entry with the conflicting version, then our stored route, then the
//          409 body (which can name the route's CREATOR after a reassign). Unknown → needs a refresh (once).
//          Our own earlier change → "already applied". "Apply mine" only if still allowed from the current status.
import { describe, expect, it } from 'vitest';
import { RouteConflictBodySchema } from '../../src/domain/api';
import { addAuditEntries, auditEntryFromMessage, type AuditLog } from '../../src/domain/auditLog';
import { describeConflict, type AttemptedChange } from '../../src/domain/conflicts';
import { WsServerMessageSchema } from '../../src/domain/events';
import type { Route } from '../../src/domain/models';
import { applyRouteMessage, isRouteMessage, type RouteMessage, type Routes } from '../../src/domain/routes';
import delayedFixture from '../../fixtures/rest/route_patch_409_delayed.json';
import immediateFixture from '../../fixtures/rest/route_patch_409_immediate.json';
import assignedFixture from '../../fixtures/ws/route_assigned.json';
import reassignedFixture from '../../fixtures/ws/route_reassigned.json';
import updatedFixture from '../../fixtures/ws/route_updated.json';

// Real captured scenario: Alice (dispatcher_41d71449) created route_1 (v1). Bob (dispatcher_34032ebe) reassigned it (v2)
// while Alice's PATCH "in-progress" with If-Match: 1 was in flight → Alice got the DELAYED 409 (currentVersion 2).
const ALICE = 'dispatcher_41d71449';
const BOB = 'dispatcher_34032ebe';

function routeMessage(raw: unknown): RouteMessage {
  const message = WsServerMessageSchema.parse(raw);
  if (!isRouteMessage(message)) throw new Error('not a route message');
  return message;
}

const assigned = routeMessage(assignedFixture);
const reassigned = routeMessage(reassignedFixture);
const updated = routeMessage(updatedFixture);
const delayedBody = RouteConflictBodySchema.parse(delayedFixture.body);
const immediateBody = RouteConflictBodySchema.parse(immediateFixture.body);

// Store state after applying the given route events in order (routes + audit log), like the real store does.
function stateAfter(...messages: RouteMessage[]): { routes: Routes; auditLog: AuditLog } {
  let routes: Routes = {};
  let auditLog: AuditLog = [];
  for (const message of messages) {
    auditLog = addAuditEntries(auditLog, [auditEntryFromMessage(routes[message.route.id], message)]);
    routes = applyRouteMessage(routes, message);
  }
  return { routes, auditLog };
}

const aliceStarts: AttemptedChange = { routeId: 'route_1', expectedVersion: 1, changes: { status: 'in-progress' } };

describe('Conflict — who and what', () => {
  it('real delayed 409 (no "who" in the body): who and what come from the WS event with that version', () => {
    const result = describeConflict(aliceStarts, delayedBody, { ...stateAfter(assigned, reassigned), myDispatcherId: ALICE });
    expect(result).toMatchObject({
      kind: 'conflict',
      who: BOB,
      whoSource: 'audit',
      currentVersion: 2,
      theirChange: { kind: 'reassigned', toTruckId: 'truck_4' },
    });
  });

  it('the audit log beats the 409 body (after a reassign the body names the route CREATOR, not who changed it)', () => {
    const misleadingBody = { ...delayedBody, lastModifiedBy: ALICE };
    const result = describeConflict(aliceStarts, misleadingBody, { ...stateAfter(assigned, reassigned), myDispatcherId: 'dispatcher_carol' });
    expect(result).toMatchObject({ kind: 'conflict', who: BOB, whoSource: 'audit' });
  });

  it('no audit entry, but our stored route is already at that version → who from the route', () => {
    const { routes } = stateAfter(assigned, reassigned);
    const result = describeConflict(aliceStarts, delayedBody, { routes, auditLog: [], myDispatcherId: ALICE });
    expect(result).toMatchObject({ kind: 'conflict', who: BOB, whoSource: 'route' });
  });

  it('nothing local yet, the body has "who" (immediate 409) → who from the server', () => {
    const attempt: AttemptedChange = { routeId: 'route_1', expectedVersion: 99, changes: { status: 'in-progress' } };
    const result = describeConflict(attempt, immediateBody, { routes: {}, auditLog: [], myDispatcherId: BOB });
    expect(result).toMatchObject({ kind: 'conflict', who: immediateBody.lastModifiedBy, whoSource: 'server' });
  });

  it('nothing known at all (delayed 409 before the WS event) → needs a refresh first', () => {
    const result = describeConflict(aliceStarts, delayedBody, { ...stateAfter(assigned), myDispatcherId: ALICE });
    expect(result).toEqual({ kind: 'needs_refresh', currentVersion: 2 });
  });

  it('still unknown after the refresh → conflict with unknown who (no endless refreshing)', () => {
    const result = describeConflict(aliceStarts, delayedBody, { ...stateAfter(assigned), myDispatcherId: ALICE }, { afterRefresh: true });
    expect(result).toMatchObject({ kind: 'conflict', who: null, whoSource: 'unknown' });
  });
});

describe('Conflict — it was me', () => {
  it('the change that beat us is OURS and the route already has what we wanted → already applied', () => {
    // Alice's earlier attempt (timed out, but succeeded) moved v2 → v3 "in-progress"; her retry still says If-Match: 2.
    const retry: AttemptedChange = { routeId: 'route_1', expectedVersion: 2, changes: { status: 'in-progress' } };
    const body = { error: 'Route was modified during processing', currentVersion: 3 };
    const result = describeConflict(retry, body, { ...stateAfter(assigned, reassigned, updated), myDispatcherId: ALICE });
    expect(result).toEqual({ kind: 'already_applied', currentVersion: 3 });
  });

  it('our own change but the route does NOT match what we want now → a normal conflict', () => {
    const cancel: AttemptedChange = { routeId: 'route_1', expectedVersion: 2, changes: { status: 'cancelled' } };
    const body = { error: 'modified', currentVersion: 3 };
    const result = describeConflict(cancel, body, { ...stateAfter(assigned, reassigned, updated), myDispatcherId: ALICE });
    expect(result).toMatchObject({ kind: 'conflict', who: ALICE });
  });
});

describe('Conflict — what can I do now', () => {
  function completedBy(who: string): RouteMessage {
    if (updated.type !== 'route_updated') throw new Error('fixture');
    const route: Route = { ...updated.route, status: 'completed', _version: 4, lastModifiedBy: who, lastModifiedAt: (updated.route.lastModifiedAt ?? 0) + 1000 };
    return { ...updated, route, updatedBy: who };
  }

  it('they already completed the route → "apply mine" (start it) is not possible', () => {
    const attempt: AttemptedChange = { routeId: 'route_1', expectedVersion: 3, changes: { status: 'in-progress' } };
    const result = describeConflict(attempt, { error: 'modified', currentVersion: 4 }, {
      ...stateAfter(assigned, reassigned, updated, completedBy(BOB)),
      myDispatcherId: ALICE,
    });
    expect(result).toMatchObject({ kind: 'conflict', who: BOB, canApplyMine: false });
  });

  it('they only reassigned it (still "assigned") → starting it is still allowed → "apply mine" possible', () => {
    const result = describeConflict(aliceStarts, delayedBody, { ...stateAfter(assigned, reassigned), myDispatcherId: ALICE });
    expect(result).toMatchObject({ kind: 'conflict', canApplyMine: true, currentRoute: { _version: 2, status: 'assigned' } });
  });

  it('we don\'t hold the current version of the route → "apply mine" not offered (we can\'t know it is safe)', () => {
    const attempt: AttemptedChange = { routeId: 'route_1', expectedVersion: 99, changes: { status: 'in-progress' } };
    const result = describeConflict(attempt, immediateBody, { routes: {}, auditLog: [], myDispatcherId: BOB });
    expect(result).toMatchObject({ kind: 'conflict', canApplyMine: false });
  });

  it('both pressed "Start": they already made exactly my change → sameAsMine, nothing to apply', () => {
    // Bob started the route (v2) while Alice's "Start" (If-Match: 1) was in flight.
    const startedByBob: RouteMessage = { ...updated, route: { ...updated.route, _version: 2, status: 'in-progress', lastModifiedBy: BOB } };
    if (startedByBob.type !== 'route_updated') throw new Error('fixture');
    const result = describeConflict(aliceStarts, delayedBody, {
      ...stateAfter(assigned, { ...startedByBob, updatedBy: BOB }),
      myDispatcherId: ALICE,
    });
    expect(result).toMatchObject({ kind: 'conflict', who: BOB, sameAsMine: true, canApplyMine: false });
  });
});
