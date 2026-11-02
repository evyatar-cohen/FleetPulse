// Feature: REST client (headers, optimistic locking header, response validation, typed errors)
// Tests:   src/transport/restClient.ts → RestClient
// Rule:    every response becomes data or a typed error (never a crash); X-Dispatcher-Id on every request once
//          registered; If-Match on route updates; writes refused locally before registration.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS, RestClient, type FetchFn } from '../../src/transport/restClient';
import alertFixture from '../../fixtures/rest/alert_201.json';
import fleetFixture from '../../fixtures/rest/fleet_200.json';
import fleetBusyFixture from '../../fixtures/rest/fleet_503.json';
import createConflictFixture from '../../fixtures/rest/route_create_409.json';
import routeCreatedFixture from '../../fixtures/rest/route_create_201.json';
import delayedConflictFixture from '../../fixtures/rest/route_patch_409_delayed.json';
import immediateConflictFixture from '../../fixtures/rest/route_patch_409_immediate.json';
import routeUpdatedFixture from '../../fixtures/rest/route_patch_200.json';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

// A fake fetch: returns the given responses in order and records every request it receives.
function fakeFetch(...responses: Response[]): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error('fakeFetch: no more responses');
    return next;
  };
  return { fetch, calls };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function headerOf(call: RecordedCall | undefined, name: string): string | undefined {
  const headers = (call?.init.headers ?? {}) as Record<string, string>;
  return headers[name];
}

function registeredClient(fetch: FetchFn): RestClient {
  const client = new RestClient({ fetch });
  client.setDispatcherId('dispatcher_alice');
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('REST client — success and headers', () => {
  it('getFleet returns validated data from a real server response', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, fleetFixture.body));
    const result = await new RestClient({ fetch }).getFleet();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fleet).toHaveLength(12);
    expect(calls[0]?.url).toBe('/api/fleet');
  });

  it('sends X-Dispatcher-Id on every request once registered (reads too)', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, fleetFixture.body));
    await registeredClient(fetch).getFleet();
    expect(headerOf(calls[0], 'X-Dispatcher-Id')).toBe('dispatcher_alice');
  });

  it('updateRoute sends PATCH with If-Match = expected version and a JSON body', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, routeUpdatedFixture.body));
    const result = await registeredClient(fetch).updateRoute('route_1', { status: 'in-progress' }, 2);
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('/api/routes/route_1');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(headerOf(calls[0], 'If-Match')).toBe('2');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ status: 'in-progress' }));
  });

  it('createRoute and sendAlert return validated data', async () => {
    const { fetch } = fakeFetch(jsonResponse(201, routeCreatedFixture.body), jsonResponse(201, alertFixture.body));
    const client = registeredClient(fetch);
    const route = await client.createRoute({ truckId: 'truck_1', destination: 'Port' });
    const alert = await client.sendAlert('truck_2', { message: 'Return to depot', severity: 'warning' });
    expect(route.ok && route.data.id).toBe('route_1');
    expect(alert.ok && alert.data.severity).toBe('warning');
  });

  it('encodes ids in the URL path (no path injection from user input)', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(404, { error: 'Truck not found' }));
    await new RestClient({ fetch }).getTruckDetail('../reset');
    expect(calls[0]?.url).toBe('/api/fleet/..%2Freset');
  });
});

describe('REST client — writes before registration', () => {
  it('refuses writes locally with not_registered and sends nothing', async () => {
    const { fetch, calls } = fakeFetch();
    const result = await new RestClient({ fetch }).createRoute({ truckId: 'truck_1', destination: 'Port' });
    expect(result).toEqual({ ok: false, error: { kind: 'not_registered' } });
    expect(calls).toHaveLength(0);
  });
});

describe('REST client — typed errors', () => {
  it('PATCH 409 immediate → version_conflict with who changed it (QUIRK #4)', async () => {
    const { fetch } = fakeFetch(jsonResponse(409, immediateConflictFixture.body));
    const result = await registeredClient(fetch).updateRoute('route_1', { status: 'in-progress' }, 99);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'version_conflict') {
      expect(result.error.body.lastModifiedBy).toBe(immediateConflictFixture.body.lastModifiedBy);
    } else {
      throw new Error(`expected version_conflict, got ${JSON.stringify(result)}`);
    }
  });

  it('PATCH 409 delayed → version_conflict without "who" (QUIRK #8)', async () => {
    const { fetch } = fakeFetch(jsonResponse(409, delayedConflictFixture.body));
    const result = await registeredClient(fetch).updateRoute('route_1', { status: 'in-progress' }, 1);
    expect(result).toMatchObject({ ok: false, error: { kind: 'version_conflict', body: { currentVersion: 2 } } });
    if (!result.ok && result.error.kind === 'version_conflict') {
      expect(result.error.body.lastModifiedBy).toBeUndefined();
    }
  });

  it('POST /routes 409 → truck_assigned with assignedBy', async () => {
    const { fetch } = fakeFetch(jsonResponse(409, createConflictFixture.body));
    const result = await registeredClient(fetch).createRoute({ truckId: 'truck_1', destination: 'Port' });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'truck_assigned', body: { assignedBy: createConflictFixture.body.assignedBy } },
    });
  });

  it('reassign 409 → target_truck_busy', async () => {
    const { fetch } = fakeFetch(jsonResponse(409, { error: 'Target truck already has an assigned route' }));
    const result = await registeredClient(fetch).reassignRoute('route_1', 'truck_4');
    expect(result).toMatchObject({ ok: false, error: { kind: 'target_truck_busy' } });
  });

  it('503 → unavailable with Retry-After in ms (QUIRK #7)', async () => {
    const { fetch } = fakeFetch(
      jsonResponse(503, fleetBusyFixture.body, { 'Retry-After': fleetBusyFixture.retryAfter ?? '' }),
    );
    const result = await new RestClient({ fetch }).getFleet();
    expect(result).toEqual({ ok: false, error: { kind: 'unavailable', retryAfterMs: 3000 } });
  });

  it('401 / 404 / 400 / 500 map to their kinds with the server message', async () => {
    const { fetch } = fakeFetch(
      jsonResponse(401, { error: 'X-Dispatcher-Id header required' }),
      jsonResponse(404, { error: 'Route not found' }),
      jsonResponse(400, { error: 'truckId and destination required' }),
      jsonResponse(500, { error: 'boom' }),
    );
    const client = registeredClient(fetch);
    expect(await client.getRoutes()).toMatchObject({ error: { kind: 'unauthorized' } });
    expect(await client.getTruckDetail('truck_99')).toMatchObject({ error: { kind: 'not_found', message: 'Route not found' } });
    expect(await client.createRoute({ truckId: '', destination: '' })).toMatchObject({ error: { kind: 'bad_request' } });
    expect(await client.getFleet()).toMatchObject({ error: { kind: 'http', status: 500 } });
  });

  it('no answer at all → network error (not a crash)', async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await new RestClient({ fetch }).getFleet();
    expect(result).toEqual({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } });
  });

  it('a request with no answer for REQUEST_TIMEOUT_MS → timeout', async () => {
    vi.useFakeTimers();
    // Never answers; rejects only when the client aborts it.
    const fetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    const pending = new RestClient({ fetch }).getFleet();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, error: { kind: 'timeout' } });
  });

  it('a 200 whose body does not match the schema → invalid_response', async () => {
    const { fetch } = fakeFetch(jsonResponse(200, { fleet: 'not a list' }));
    expect(await new RestClient({ fetch }).getFleet()).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  });

  it('a body that is not JSON → invalid_response', async () => {
    const { fetch } = fakeFetch(new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(await new RestClient({ fetch }).getFleet()).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response', status: 502 },
    });
  });
});
