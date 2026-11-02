// Feature: Startup sequence and wiring (composition root)
// Tests:   src/app/startup.ts → startApp()
// Rule:    WS register first → only then load the fleet (with our id) and open SSE. Fleet refresh every 30 s;
//          3× 503 → "stale" + probe at the end of the breaker cooldown; reload on fleet_reset and after an SSE
//          reconnect; stop() closes everything and stops refreshing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_REFRESH_MS, startApp, type RunningApp } from '../../src/app/startup';
import { useFleetStore } from '../../src/store/fleetStore';
import type { FetchFn } from '../../src/transport/restClient';
import { FakeEventSource, FakeWebSocket, jsonResponse, memoryIdStore, SSE_CLOSED } from '../helpers/fakes';
import fleetFixture from '../../fixtures/rest/fleet_200.json';
import busyFixture from '../../fixtures/rest/fleet_503.json';

let sockets: FakeWebSocket[];
let sources: FakeEventSource[];
let fleetRequests: RequestInit[];
// Next responses for GET /api/fleet; when empty → 200 with the fixture.
let fleetQueue: Response[];
let app: RunningApp | null;

const fetch: FetchFn = async (url, init) => {
  if (url === '/api/fleet') {
    fleetRequests.push(init);
    return fleetQueue.shift() ?? jsonResponse(200, fleetFixture.body);
  }
  return jsonResponse(404, { error: 'not used in this test' });
};

function busy(): Response {
  return jsonResponse(503, busyFixture.body, { 'Retry-After': '3' });
}

function start(): RunningApp {
  app = startApp(
    'Alice',
    {
      fetch,
      createEventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      idStore: memoryIdStore(),
      wsUrl: 'ws://localhost:5173/ws',
    },
    useFleetStore,
  );
  return app;
}

function socket(): FakeWebSocket {
  const latest = sockets.at(-1);
  if (latest === undefined) throw new Error('no socket');
  return latest;
}

async function register(): Promise<void> {
  socket().emitOpen();
  socket().emitMessage({ type: 'registered', dispatcherId: 'dispatcher_alice' });
  // Let the async fleet load finish.
  await vi.advanceTimersByTimeAsync(0);
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return ((init?.headers ?? {}) as Record<string, string>)[name];
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  sources = [];
  fleetRequests = [];
  fleetQueue = [];
  app = null;
  useFleetStore.getState().resetFleet();
  useFleetStore.getState().setFleetStale(false);
});

afterEach(() => {
  app?.stop();
  vi.useRealTimers();
});

describe('Startup order', () => {
  it('before `registered`: WS is connecting, no fleet request, no SSE', () => {
    start();
    socket().emitOpen();
    expect(sockets).toHaveLength(1);
    expect(fleetRequests).toHaveLength(0);
    expect(sources).toHaveLength(0);
  });

  it('after `registered`: fleet loaded with our X-Dispatcher-Id, then SSE opened', async () => {
    start();
    await register();
    const state = useFleetStore.getState();
    expect(headerOf(fleetRequests[0], 'X-Dispatcher-Id')).toBe('dispatcher_alice');
    expect(Object.keys(state.trucks)).toHaveLength(12);
    expect(state.dispatcherId).toBe('dispatcher_alice');
    expect(sources).toHaveLength(1);
  });
});

describe('Fleet refresh and degraded mode', () => {
  it('reloads the fleet every 30 s', async () => {
    start();
    await register();
    await vi.advanceTimersByTimeAsync(FLEET_REFRESH_MS);
    expect(fleetRequests).toHaveLength(2);
  });

  it('503 ×3 → stale; the next call is the probe at the end of the 10 s cooldown; success clears stale', async () => {
    fleetQueue = [busy(), busy(), busy()];
    start();
    await register();
    // Attempt 1 → wait 3 s → attempt 2 → wait 3 s → attempt 3 → breaker opens.
    await vi.advanceTimersByTimeAsync(6000);
    expect(fleetRequests).toHaveLength(3);
    expect(useFleetStore.getState().fleetStale).toBe(true);

    await vi.advanceTimersByTimeAsync(9999);
    expect(fleetRequests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fleetRequests).toHaveLength(4);
    expect(useFleetStore.getState().fleetStale).toBe(false);
  });
});

describe('Reloads after missed data', () => {
  it('fleet_reset → local trucks cleared and the fleet reloaded', async () => {
    start();
    await register();
    const resetSpy = vi.spyOn(useFleetStore.getState(), 'resetFleet');
    socket().emitMessage({ type: 'fleet_reset', timestamp: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(fleetRequests).toHaveLength(2);
    expect(Object.keys(useFleetStore.getState().trucks)).toHaveLength(12);
  });

  it('SSE back after a reconnect → fleet reloaded (telemetry gap cannot be replayed)', async () => {
    start();
    await register();
    const first = sources.at(-1);
    first?.emitOpen();
    first?.emitError(SSE_CLOSED);
    await vi.advanceTimersByTimeAsync(1000);
    sources.at(-1)?.emitOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(fleetRequests).toHaveLength(2);
  });
});

describe('Stop', () => {
  it('stop() closes WS and SSE and stops refreshing', async () => {
    const running = start();
    await register();
    running.stop();
    app = null;
    await vi.advanceTimersByTimeAsync(5 * FLEET_REFRESH_MS);
    expect(socket().closed).toBe(true);
    expect(sources.at(-1)?.closed).toBe(true);
    expect(fleetRequests).toHaveLength(1);
  });
});
