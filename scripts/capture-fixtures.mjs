// Phase 0 tool — NOT part of the app.
// Connects to the running mock server (SSE + WebSocket + REST), triggers each quirk we can trigger,
// and saves real payloads as JSON files under fixtures/. Unit tests use these files later.
//
// Usage: start the server (node server.js), then: node scripts/capture-fixtures.mjs
// Uses only Node built-ins (fetch, WebSocket — global since Node 22). No dependencies.

import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';
const OUT_DIR = new URL('../fixtures/', import.meta.url);
const SSE_TIMEOUT_MS = 240_000;
// How many telemetry events to keep before/after an anomaly — enough to see it start and recover.
const WINDOW_BEFORE = 3;
const WINDOW_AFTER = 7;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function save(relativePath, data) {
  const fileUrl = new URL(relativePath, OUT_DIR);
  await mkdir(new URL('.', fileUrl), { recursive: true });
  await writeFile(fileUrl, JSON.stringify(data, null, 2) + '\n');
  console.log('  saved', relativePath);
}

// ---------- REST ----------

async function call(method, path, { body, headers = {} } = {}) {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: await response.json(),
  };
}

// ---------- WebSocket ----------

// Opens a socket, registers, and resolves once the server answers `registered`.
// Every incoming message is kept in `inbox` with the time we received it.
function openDispatcher(name, dispatcherId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'register_dispatcher', name, dispatcherId }));
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      inbox.push({ receivedAt: Date.now(), msg });
      if (msg.type === 'registered') {
        resolve({ ws, inbox, id: msg.dispatcherId });
      }
    });
  });
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    ws.addEventListener('close', resolve);
    ws.close();
  });
}

async function waitFor(inbox, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = inbox.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

function firstOfType(inbox, type) {
  const hit = inbox.find((entry) => entry.msg.type === type);
  return hit ? hit.msg : null;
}

// ---------- SSE ----------

// Reads the raw SSE stream with fetch and splits it into `data:` frames ourselves,
// so we see exactly what the server writes. Stops when `isDone(events)` is true or on timeout.
async function captureSse(isDone) {
  const events = [];
  const controller = new AbortController();
  const response = await fetch(BASE_URL + '/api/telemetry/stream', { signal: controller.signal });
  const decoder = new TextDecoder();
  const deadline = Date.now() + SSE_TIMEOUT_MS;
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      if (frame.startsWith('data: ')) {
        events.push({ receivedAt: Date.now(), event: JSON.parse(frame.slice('data: '.length)) });
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
    if (isDone(events) || Date.now() > deadline) break;
  }
  controller.abort();
  return events;
}

function hasReading(entry, predicate) {
  return entry.event.type === 'telemetry' && entry.event.readings.some(predicate);
}

const isStuckSpeed = (reading) => reading.speed === 999;
const isFuelZero = (reading) => reading.fuel === 0;
const isReordered = (reading) => reading._reordered === true;

function firstIndex(events, predicate) {
  return events.findIndex(predicate);
}

// Everything the server sent about one truck around event `index`:
// telemetry events reduced to that truck's reading, gps_batch events for that truck kept whole.
function windowForTruck(events, index, truckId) {
  const slice = events.slice(Math.max(0, index - WINDOW_BEFORE), index + WINDOW_AFTER + 1);
  const result = [];
  for (const entry of slice) {
    const { event } = entry;
    if (event.type === 'telemetry') {
      const reading = event.readings.find((r) => r.truckId === truckId);
      result.push({ receivedAt: entry.receivedAt, type: 'telemetry', eventTimestamp: event.timestamp, reading });
    } else if (event.type === 'gps_batch' && event.truckId === truckId) {
      result.push({ receivedAt: entry.receivedAt, ...event });
    }
  }
  return result;
}

function enoughAfter(events, predicate) {
  const index = firstIndex(events, predicate);
  return index !== -1 && events.length > index + WINDOW_AFTER;
}

function sseIsDone(events) {
  return (
    enoughAfter(events, (e) => e.event.type === 'gps_batch') &&
    enoughAfter(events, (e) => hasReading(e, isReordered)) &&
    enoughAfter(events, (e) => hasReading(e, isStuckSpeed)) &&
    enoughAfter(events, (e) => hasReading(e, isFuelZero))
  );
}

async function saveSseFixtures(events) {
  const counts = {};
  for (const { event } of events) counts[event.type] = (counts[event.type] || 0) + 1;
  console.log('SSE event counts:', counts);

  const connected = events.find((e) => e.event.type === 'connected');
  if (connected) await save('sse/connected.json', connected.event);

  const heartbeat = events.find((e) => e.event.type === 'heartbeat');
  if (heartbeat) await save('sse/heartbeat.json', heartbeat.event);

  const clean = events.find(
    (e) => e.event.type === 'telemetry' &&
      !hasReading(e, isReordered) && !hasReading(e, isStuckSpeed) && !hasReading(e, isFuelZero),
  );
  if (clean) await save('sse/telemetry.json', clean.event);

  const reordered = events.find((e) => hasReading(e, isReordered));
  if (reordered) await save('sse/telemetry_reordered.json', reordered.event);

  const batchIndex = firstIndex(events, (e) => e.event.type === 'gps_batch');
  if (batchIndex !== -1) {
    const batch = events[batchIndex].event;
    await save('sse/gps_batch.json', batch);
    await save('sse/gps_batch_context.json', windowForTruck(events, batchIndex, batch.truckId));
  }

  const stuckIndex = firstIndex(events, (e) => hasReading(e, isStuckSpeed));
  if (stuckIndex !== -1) {
    const truckId = events[stuckIndex].event.readings.find(isStuckSpeed).truckId;
    await save('sse/speed_stuck_sequence.json', windowForTruck(events, stuckIndex, truckId));
  }

  const fuelIndex = firstIndex(events, (e) => hasReading(e, isFuelZero));
  if (fuelIndex !== -1) {
    const truckId = events[fuelIndex].event.readings.find(isFuelZero).truckId;
    await save('sse/fuel_glitch_sequence.json', windowForTruck(events, fuelIndex, truckId));
  }

  if (batchIndex === -1) console.log('  NOT captured (timeout): gps_batch');
  if (!reordered) console.log('  NOT captured (timeout): reordered reading');
  if (stuckIndex === -1) console.log('  NOT captured (timeout): speed 999');
  if (fuelIndex === -1) console.log('  NOT captured (timeout): fuel 0');
}

// ---------- Scenarios ----------

async function captureRest(alice, bob) {
  const asAlice = { 'X-Dispatcher-Id': alice.id };
  const asBob = { 'X-Dispatcher-Id': bob.id };

  // QUIRK 7: call /api/fleet until we have seen both a 200 and a 503.
  let fleetOk = null;
  let fleetBusy = null;
  for (let attempt = 0; attempt < 60 && (!fleetOk || !fleetBusy); attempt++) {
    const result = await call('GET', '/api/fleet');
    if (result.status === 200 && !fleetOk) fleetOk = result;
    if (result.status === 503 && !fleetBusy) fleetBusy = result;
  }
  if (fleetOk) await save('rest/fleet_200.json', fleetOk);
  if (fleetBusy) await save('rest/fleet_503.json', fleetBusy);

  await save('rest/truck_detail.json', await call('GET', '/api/fleet/truck_1'));
  await save('rest/telemetry_history.json', await call('GET', '/api/telemetry/history/truck_1?limit=5'));

  const routeBody = { truckId: 'truck_1', destination: 'Port of Tel Aviv', priority: 'high', notes: 'fixture' };
  await save('rest/route_create_401.json', await call('POST', '/api/routes', { body: routeBody }));
  const created = await call('POST', '/api/routes', { body: routeBody, headers: asAlice });
  await save('rest/route_create_201.json', created);
  // Same truck again → 409 with `assignedBy`.
  await save('rest/route_create_409.json', await call('POST', '/api/routes', { body: routeBody, headers: asBob }));

  const routeId = created.body.id;
  // QUIRK 4: stale If-Match → immediate 409 (has lastModifiedBy).
  await save('rest/route_patch_409_immediate.json', await call('PATCH', `/api/routes/${routeId}`, {
    body: { status: 'in-progress' }, headers: { ...asBob, 'If-Match': '99' },
  }));

  // QUIRK 8: Alice's PATCH passes the first version check, then waits 200–1000 ms on the server.
  // Bob reassigns during that wait → version changes → Alice gets the delayed 409 (no lastModifiedBy).
  const alicePatch = call('PATCH', `/api/routes/${routeId}`, {
    body: { status: 'in-progress' }, headers: { ...asAlice, 'If-Match': String(created.body._version) },
  });
  await sleep(50);
  const bobReassign = call('PUT', `/api/routes/${routeId}/reassign`, { body: { newTruckId: 'truck_4' }, headers: asBob });
  await save('rest/route_patch_409_delayed.json', await alicePatch);
  const reassigned = await bobReassign;
  await save('rest/route_reassign_200.json', reassigned);

  await save('rest/route_patch_200.json', await call('PATCH', `/api/routes/${routeId}`, {
    body: { status: 'in-progress' }, headers: { ...asAlice, 'If-Match': String(reassigned.body._version) },
  }));
  await save('rest/routes.json', await call('GET', '/api/routes'));
  await save('rest/alert_201.json', await call('POST', '/api/fleet/truck_2/alert', {
    body: { message: 'Low fuel, return to depot', severity: 'warning' }, headers: asAlice,
  }));
}

// QUIRK 6: close a dispatcher repeatedly until we see one normal leave and one ghost (delayed) leave.
// On a ghost, reconnect with the SAME id before the late `dispatcher_left` arrives — the hard case.
async function capturePresence(observer) {
  const carolId = 'dispatcher_fixture_carol';
  let normalLeave = null;
  let ghostSequence = null;

  for (let attempt = 0; attempt < 25 && (!normalLeave || !ghostSequence); attempt++) {
    const carol = await openDispatcher('Carol', carolId);
    await sleep(200);
    const closedAt = Date.now();
    await closeSocket(carol.ws);
    const isCarolLeft = (e) => e.msg.type === 'dispatcher_left' && e.msg.dispatcherId === carolId && e.receivedAt >= closedAt;

    const quickLeave = await waitFor(observer.inbox, isCarolLeft, 1000);
    if (quickLeave) {
      if (!normalLeave) normalLeave = { closedAt, ...quickLeave };
      continue;
    }
    if (ghostSequence) continue;

    // Ghost: Carol comes back with the same id while the old leave is still pending.
    const carolAgain = await openDispatcher('Carol', carolId);
    const lateLeave = await waitFor(observer.inbox, isCarolLeft, 12_000);
    ghostSequence = {
      note: 'Carol closed, reconnected with the same id, then the delayed dispatcher_left arrived while she was connected.',
      closedAt,
      reconnectedAt: carolAgain.inbox[0].receivedAt,
      observed: observer.inbox.filter((e) => e.receivedAt >= closedAt && e.msg.dispatcherId === carolId),
      lateLeaveDelayMs: lateLeave ? lateLeave.receivedAt - closedAt : null,
    };
    await closeSocket(carolAgain.ws);
  }

  if (normalLeave) await save('ws/dispatcher_left.json', normalLeave.msg);
  if (ghostSequence) await save('ws/ghost_reconnect_sequence.json', ghostSequence);
  else console.log('  NOT captured: ghost leave (20% chance per close)');
}

async function main() {
  console.log('Resetting server state…');
  await call('POST', '/api/reset');

  console.log('Opening SSE stream (runs until all telemetry quirks are seen)…');
  const ssePromise = captureSse(sseIsDone);

  const alice = await openDispatcher('Alice');
  const bob = await openDispatcher('Bob');

  alice.ws.send(JSON.stringify({ type: 'ping' }));
  alice.ws.send(JSON.stringify({ type: 'viewing_truck', truckId: 'truck_3' }));
  bob.ws.send('not json');

  console.log('REST scenarios…');
  await captureRest(alice, bob);

  console.log('Presence scenarios (may take ~1 min)…');
  await capturePresence(bob);

  console.log('Waiting for SSE quirks…');
  const sseEvents = await ssePromise;
  await saveSseFixtures(sseEvents);

  await call('POST', '/api/reset');
  await waitFor(alice.inbox, (e) => e.msg.type === 'fleet_reset', 2000);

  console.log('Saving WS fixtures…');
  const wsTypes = ['registered', 'pong', 'error', 'dispatcher_joined', 'dispatcher_viewing',
    'route_assigned', 'route_updated', 'route_reassigned', 'truck_alert', 'fleet_reset'];
  for (const type of wsTypes) {
    const msg = firstOfType(alice.inbox, type) || firstOfType(bob.inbox, type);
    if (msg) await save(`ws/${type}.json`, msg);
    else console.log('  NOT captured:', type);
  }

  await closeSocket(alice.ws);
  await closeSocket(bob.ws);
  console.log('Done.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
