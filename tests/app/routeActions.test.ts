// Feature: Route actions (create / update status / apply mine / reassign) — optimistic locking flow end to end
// Tests:   src/app/routeActions.ts → createRouteActions()
// Rule:    client rules first (nothing sent if invalid); always If-Match = the version we hold; ONE request (writes are
//          never retried automatically); 409 → who/what (reload routes once if unknown); our own earlier change →
//          already applied; network/timeout → retryable error for a manual Retry.
import { beforeEach, describe, expect, it } from 'vitest';
import { createRouteActions } from '../../src/app/routeActions';
import { FleetResponseSchema } from '../../src/domain/api';
import { WsServerMessageSchema } from '../../src/domain/events';
import { isRouteMessage, type RouteMessage } from '../../src/domain/routes';
import { useFleetStore } from '../../src/store/fleetStore';
import { RestClient, type FetchFn } from '../../src/transport/restClient';
import { jsonResponse } from '../helpers/fakes';
import fleetFixture from '../../fixtures/rest/fleet_200.json';
import delayedFixture from '../../fixtures/rest/route_patch_409_delayed.json';
import routesFixture from '../../fixtures/rest/routes.json';
import assignedFixture from '../../fixtures/ws/route_assigned.json';
import reassignedFixture from '../../fixtures/ws/route_reassigned.json';
import updatedFixture from '../../fixtures/ws/route_updated.json';

const ALICE = 'dispatcher_41d71449';
const BOB = 'dispatcher_34032ebe';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[];
// Scripted answers per "METHOD url"; each call takes the next one.
let answers: Record<string, Array<Response | Error>>;

const fetch: FetchFn = async (url, init) => {
  const method = init.method ?? 'GET';
  calls.push({
    method,
    url,
    headers: (init.headers ?? {}) as Record<string, string>,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  });
  const next = answers[`${method} ${url}`]?.shift();
  if (next === undefined) throw new Error(`no scripted answer for ${method} ${url}`);
  if (next instanceof Error) throw next;
  return next;
};

function routeMessage(raw: unknown): RouteMessage {
  const message = WsServerMessageSchema.parse(raw);
  if (!isRouteMessage(message)) throw new Error('fixture');
  return message;
}

function actions(): ReturnType<typeof createRouteActions> {
  const rest = new RestClient({ fetch });
  rest.setDispatcherId(ALICE);
  return createRouteActions(rest, useFleetStore);
}

function callsTo(method: string, urlPart: string): Call[] {
  return calls.filter((call) => call.method === method && call.url.includes(urlPart));
}

beforeEach(() => {
  calls = [];
  answers = {};
  const store = useFleetStore.getState();
  store.resetFleet();
  store.applyFleetResponse(FleetResponseSchema.parse(fleetFixture.body));
  store.setDispatcher(ALICE, 'Alice');
  // Alice holds route_1 at v1 (assigned).
  store.applyRouteMessage(routeMessage(assignedFixture));
});

describe('Update status — happy path and client rules', () => {
  it('sends PATCH with If-Match = the version we hold', async () => {
    answers['PATCH /api/routes/route_1'] = [jsonResponse(200, { ...updatedFixture.route, _version: 2 })];
    const outcome = await actions().updateStatus('route_1', 'in-progress');
    expect(outcome).toEqual({ kind: 'success' });
    expect(callsTo('PATCH', 'route_1')[0]?.headers['If-Match']).toBe('1');
    expect(callsTo('PATCH', 'route_1')[0]?.body).toEqual({ status: 'in-progress' });
  });

  it('a transition our rules forbid (assigned → completed) is not sent at all', async () => {
    const outcome = await actions().updateStatus('route_1', 'completed');
    expect(outcome.kind).toBe('invalid');
    expect(calls).toHaveLength(0);
  });
});

describe('Update status — conflicts (optimistic locking)', () => {
  it('delayed 409 after Bob reassigned (WS event already here) → conflict: who = Bob, what = reassigned', async () => {
    useFleetStore.getState().applyRouteMessage(routeMessage(reassignedFixture));
    // Alice's screen was still based on v1 when she clicked (simulate by calling with the v1 attempt via applyMine).
    answers['PATCH /api/routes/route_1'] = [jsonResponse(409, delayedFixture.body)];
    const outcome = await actions().applyMine({ routeId: 'route_1', expectedVersion: 1, changes: { status: 'in-progress' } }, 1);
    expect(outcome).toMatchObject({ kind: 'conflict', conflict: { who: BOB, whoSource: 'audit', canApplyMine: true } });
  });

  it('delayed 409 BEFORE the WS event → routes reloaded once → who found from the reloaded route', async () => {
    answers['PATCH /api/routes/route_1'] = [jsonResponse(409, delayedFixture.body)];
    // The reloaded route is at v2, reassigned by Bob.
    answers['GET /api/routes'] = [jsonResponse(200, { routes: [reassignedFixture.route], timestamp: 1 })];
    const outcome = await actions().updateStatus('route_1', 'in-progress');
    expect(callsTo('GET', '/api/routes')).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: 'conflict', conflict: { who: BOB, currentVersion: 2 } });
  });

  it('manual Retry after a timeout that actually worked (store not updated yet) → 409 → reload → already applied', async () => {
    useFleetStore.getState().applyRouteMessage(routeMessage(reassignedFixture)); // store at v2
    // The first attempt reached the server (v3, in-progress by Alice) but its answer and WS event were lost.
    answers['PATCH /api/routes/route_1'] = [jsonResponse(409, { error: 'Route was modified during processing', currentVersion: 3 })];
    answers['GET /api/routes'] = [jsonResponse(200, { routes: [updatedFixture.route], timestamp: 1 })];
    const outcome = await actions().updateStatus('route_1', 'in-progress');
    expect(outcome).toEqual({ kind: 'already_applied' });
  });

  it('Retry when the store already shows the wanted status → already applied, nothing sent', async () => {
    const store = useFleetStore.getState();
    store.applyRouteMessage(routeMessage(reassignedFixture));
    store.applyRouteMessage(routeMessage(updatedFixture)); // v3 in-progress
    expect(await actions().updateStatus('route_1', 'in-progress')).toEqual({ kind: 'already_applied' });
    expect(calls).toHaveLength(0);
  });

  it('"apply mine" resends with the CURRENT version in If-Match', async () => {
    answers['PATCH /api/routes/route_1'] = [jsonResponse(200, updatedFixture.route)];
    useFleetStore.getState().applyRouteMessage(routeMessage(reassignedFixture));
    await actions().applyMine({ routeId: 'route_1', expectedVersion: 1, changes: { status: 'in-progress' } }, 2);
    expect(callsTo('PATCH', 'route_1')[0]?.headers['If-Match']).toBe('2');
  });
});

describe('Update status — no answer', () => {
  it('network error → retryable error, and the write is NOT retried automatically', async () => {
    answers['PATCH /api/routes/route_1'] = [new TypeError('Failed to fetch'), jsonResponse(200, updatedFixture.route)];
    const outcome = await actions().updateStatus('route_1', 'in-progress');
    expect(outcome).toMatchObject({ kind: 'error', retryable: true });
    expect(callsTo('PATCH', 'route_1')).toHaveLength(1);
  });
});

describe('Create route', () => {
  it('a truck in maintenance is refused by our rules — nothing sent (the server would accept it)', async () => {
    const outcome = await actions().createRoute({ truckId: 'truck_7', destination: 'Haifa Port' });
    expect(outcome).toMatchObject({ kind: 'invalid', errors: { truckId: 'Truck is in maintenance' } });
    expect(calls).toHaveLength(0);
  });

  it('sends cleaned input (trimmed, default priority)', async () => {
    answers['POST /api/routes'] = [jsonResponse(201, { ...routesFixture.body.routes[0], id: 'route_2', truckId: 'truck_2', _version: 1 })];
    expect(await actions().createRoute({ truckId: 'truck_2', destination: '  Haifa Port ' })).toEqual({ kind: 'success' });
    expect(callsTo('POST', '/api/routes')[0]?.body).toEqual({ truckId: 'truck_2', destination: 'Haifa Port', priority: 'normal', notes: '' });
  });

  it('409 "truck already assigned" by ME → truck_taken with byMe (my earlier attempt worked)', async () => {
    answers['POST /api/routes'] = [jsonResponse(409, { error: 'Truck already assigned', currentRouteId: 'route_2', assignedBy: ALICE })];
    const outcome = await actions().createRoute({ truckId: 'truck_2', destination: 'Haifa Port' });
    expect(outcome).toEqual({ kind: 'truck_taken', routeId: 'route_2', by: ALICE, byMe: true });
  });
});

describe('Reassign', () => {
  it('to a truck in maintenance → refused by our rules, nothing sent', async () => {
    expect((await actions().reassign('route_1', 'truck_7', 1)).kind).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  it('server says the target is busy (someone was faster) → error with the server message', async () => {
    answers['PUT /api/routes/route_1/reassign'] = [jsonResponse(409, { error: 'Target truck already has an assigned route' })];
    expect(await actions().reassign('route_1', 'truck_2', 1)).toEqual({
      kind: 'error',
      message: 'Target truck already has an assigned route',
      retryable: false,
    });
  });

  it('route changed since the dialog opened (Bob updated it) → warn with who/what, nothing sent', async () => {
    useFleetStore.getState().applyRouteMessage(routeMessage(reassignedFixture)); // v2 by Bob
    const outcome = await actions().reassign('route_1', 'truck_2', 1);
    expect(outcome).toMatchObject({ kind: 'changed_since_opened', by: BOB, change: { kind: 'reassigned' } });
    expect(calls).toHaveLength(0);
  });

  it('after the warning the dispatcher confirms → sent; success carries the server reassign time', async () => {
    useFleetStore.getState().applyRouteMessage(routeMessage(reassignedFixture));
    answers['PUT /api/routes/route_1/reassign'] = [jsonResponse(200, { ...reassignedFixture.route, truckId: 'truck_2', _version: 3, reassignedAt: 777 })];
    const outcome = await actions().reassign('route_1', 'truck_2', 1, true);
    expect(outcome).toEqual({ kind: 'success', reassignedAt: 777 });
  });
});
