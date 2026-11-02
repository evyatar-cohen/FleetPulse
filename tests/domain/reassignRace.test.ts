// Feature: Reassign race (the server has NO version check on reassign)
// Tests:   src/domain/reassignRace.ts → changedSinceOpened(), findConcurrentReassign()
// Rule:    before sending — did the route change since the dialog opened (who/what)? After sending — did another
//          dispatcher reassign the same route within ±5 s of ours?
import { describe, expect, it } from 'vitest';
import { addAuditEntries, auditEntryFromMessage, type AuditEntry, type AuditLog } from '../../src/domain/auditLog';
import { WsServerMessageSchema } from '../../src/domain/events';
import type { Route } from '../../src/domain/models';
import { changedSinceOpened, findConcurrentReassign, REASSIGN_RACE_WINDOW_MS } from '../../src/domain/reassignRace';
import { isRouteMessage, type RouteMessage } from '../../src/domain/routes';
import assignedFixture from '../../fixtures/ws/route_assigned.json';
import reassignedFixture from '../../fixtures/ws/route_reassigned.json';

const ALICE = 'dispatcher_41d71449';
const BOB = 'dispatcher_34032ebe';

function routeMessage(raw: unknown): RouteMessage {
  const message = WsServerMessageSchema.parse(raw);
  if (!isRouteMessage(message)) throw new Error('fixture');
  return message;
}

const assigned = routeMessage(assignedFixture);
const reassigned = routeMessage(reassignedFixture);

function logOf(...messages: RouteMessage[]): AuditLog {
  let log: AuditLog = [];
  let previous: Route | undefined = undefined;
  for (const message of messages) {
    log = addAuditEntries(log, [auditEntryFromMessage(previous, message)]);
    previous = message.route;
  }
  return log;
}

function reassignEntry(by: string, at: number): AuditEntry {
  return {
    key: `route_1:reassigned:${at}`,
    at,
    routeId: 'route_1',
    by,
    version: 9,
    action: { kind: 'reassigned', fromTruckId: 'truck_1', toTruckId: 'truck_5' },
    source: 'live',
  };
}

describe('Reassign race — before sending', () => {
  it('route unchanged since the dialog opened → null (go ahead)', () => {
    expect(changedSinceOpened(assigned.route, 1, logOf(assigned))).toBeNull();
  });

  it('Bob reassigned it after the dialog opened → who and what', () => {
    expect(changedSinceOpened(reassigned.route, 1, logOf(assigned, reassigned))).toEqual({
      by: BOB,
      change: { kind: 'reassigned', fromTruckId: 'truck_1', toTruckId: 'truck_4' },
    });
  });

  it('changed but no audit entry for it → still flagged, who unknown', () => {
    expect(changedSinceOpened(reassigned.route, 1, [])).toEqual({ by: null, change: null });
  });
});

describe('Reassign race — after sending', () => {
  const myAt = 100_000;

  it('another dispatcher reassigned the same route within the window → found', () => {
    const log = addAuditEntries([], [reassignEntry(BOB, myAt + 2000)]);
    expect(findConcurrentReassign(log, 'route_1', ALICE, myAt)?.by).toBe(BOB);
  });

  it('just inside and just outside ±5 s', () => {
    const inside = addAuditEntries([], [reassignEntry(BOB, myAt - REASSIGN_RACE_WINDOW_MS)]);
    const outside = addAuditEntries([], [reassignEntry(BOB, myAt + REASSIGN_RACE_WINDOW_MS + 1)]);
    expect(findConcurrentReassign(inside, 'route_1', ALICE, myAt)).not.toBeNull();
    expect(findConcurrentReassign(outside, 'route_1', ALICE, myAt)).toBeNull();
  });

  it('my own reassign, or another route, is not a clash', () => {
    const log = addAuditEntries([], [reassignEntry(ALICE, myAt), { ...reassignEntry(BOB, myAt), routeId: 'route_2', key: 'route_2:x' }]);
    expect(findConcurrentReassign(log, 'route_1', ALICE, myAt)).toBeNull();
  });
});
