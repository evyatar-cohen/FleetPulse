// Feature: Circuit breaker for GET /api/fleet (bonus — degraded mode on repeated 503)
// Tests:   src/transport/circuitBreaker.ts → CircuitBreaker
// Rule:    3 failures in a row (503 / network / timeout) → OPEN: calls return circuit_open without calling the server.
//          After a 10 s cooldown the next call is a single probe (HALF-OPEN): success → CLOSED, failure → OPEN again.
//          Any other answer from the server (200, 404, 409…) means the server is responding → resets the count.
import { describe, expect, it } from 'vitest';
import { err, ok } from '../../src/domain/result';
import { CircuitBreaker } from '../../src/transport/circuitBreaker';
import type { ApiResult } from '../../src/transport/restClient';
import { withRetry } from '../../src/transport/retry';

const COOLDOWN_MS = 10_000;

// A controllable clock: tests move time forward by hand.
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

function counted<T>(result: ApiResult<T>): { operation: () => Promise<ApiResult<T>>; calls: () => number } {
  let count = 0;
  return {
    operation: async () => {
      count++;
      return result;
    },
    calls: () => count,
  };
}

const busy: ApiResult<string> = err({ kind: 'unavailable', retryAfterMs: 3000 });
const success: ApiResult<string> = ok('fleet');

function makeBreaker(clock = fakeClock()): { breaker: CircuitBreaker; clock: ReturnType<typeof fakeClock> } {
  return { breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: COOLDOWN_MS, now: clock.now }), clock };
}

async function failTimes(breaker: CircuitBreaker, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await breaker.call(async () => busy);
  }
}

describe('Circuit breaker — closed', () => {
  it('passes calls through while healthy', async () => {
    const { breaker } = makeBreaker();
    expect(await breaker.call(async () => success)).toEqual(success);
    expect(breaker.state).toBe('closed');
  });

  it('2 failures then a success → still closed, count reset (failures must be consecutive)', async () => {
    const { breaker } = makeBreaker();
    await failTimes(breaker, 2);
    await breaker.call(async () => success);
    await failTimes(breaker, 2);
    expect(breaker.state).toBe('closed');
  });

  it('a non-health error (e.g. 404) is a server answer → resets the count', async () => {
    const { breaker } = makeBreaker();
    await failTimes(breaker, 2);
    await breaker.call(async () => err({ kind: 'not_found', message: 'Truck not found' }));
    await failTimes(breaker, 2);
    expect(breaker.state).toBe('closed');
  });

  it('network errors and timeouts count as failures too', async () => {
    const { breaker } = makeBreaker();
    await breaker.call(async () => err({ kind: 'network', message: 'Failed to fetch' }));
    await breaker.call(async () => err({ kind: 'timeout' }));
    await breaker.call(async () => busy);
    expect(breaker.state).toBe('open');
  });
});

describe('Circuit breaker — open', () => {
  it('3 failures in a row → open; next call returns circuit_open without calling the server', async () => {
    const { breaker } = makeBreaker();
    await failTimes(breaker, 3);
    const { operation, calls } = counted(success);
    const result = await breaker.call(operation);
    expect(breaker.state).toBe('open');
    expect(result).toEqual(err({ kind: 'circuit_open', retryAtMs: COOLDOWN_MS }));
    expect(calls()).toBe(0);
  });

  it('exposes when the cooldown ends, so the caller can schedule the probe', async () => {
    const clock = fakeClock(5000);
    const { breaker } = makeBreaker(clock);
    await failTimes(breaker, 3);
    expect(breaker.openUntil).toBe(5000 + COOLDOWN_MS);
  });

  it('still open just before the cooldown ends', async () => {
    const { breaker, clock } = makeBreaker();
    await failTimes(breaker, 3);
    clock.advance(COOLDOWN_MS - 1);
    const { operation, calls } = counted(success);
    await breaker.call(operation);
    expect(calls()).toBe(0);
  });
});

describe('Circuit breaker — half-open probe', () => {
  it('after the cooldown, one probe goes through; success → closed', async () => {
    const { breaker, clock } = makeBreaker();
    await failTimes(breaker, 3);
    clock.advance(COOLDOWN_MS);
    expect(breaker.state).toBe('half_open');
    const { operation, calls } = counted(success);
    expect(await breaker.call(operation)).toEqual(success);
    expect(calls()).toBe(1);
    expect(breaker.state).toBe('closed');
  });

  it('probe fails → open again with a fresh cooldown', async () => {
    const { breaker, clock } = makeBreaker();
    await failTimes(breaker, 3);
    clock.advance(COOLDOWN_MS);
    await breaker.call(async () => busy);
    expect(breaker.state).toBe('open');
    expect(breaker.openUntil).toBe(2 * COOLDOWN_MS);
  });

  it('only ONE probe at a time: a second call during the probe gets circuit_open', async () => {
    const { breaker, clock } = makeBreaker();
    await failTimes(breaker, 3);
    clock.advance(COOLDOWN_MS);

    let finishProbe: (result: ApiResult<string>) => void = () => undefined;
    const slowProbe = breaker.call(
      () => new Promise<ApiResult<string>>((resolve) => {
        finishProbe = resolve;
      }),
    );
    const { operation, calls } = counted(success);
    const second = await breaker.call(operation);

    expect(second.ok).toBe(false);
    expect(calls()).toBe(0);
    finishProbe(success);
    expect(await slowProbe).toEqual(success);
    expect(breaker.state).toBe('closed');
  });
});

describe('Circuit breaker + retry together', () => {
  it('one retried call with 503 ×3 opens the breaker; the next call fails fast with no waiting', async () => {
    const { breaker } = makeBreaker();
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };

    const first = await withRetry(() => breaker.call(async () => busy), { sleep });
    expect(first).toEqual(busy);
    expect(breaker.state).toBe('open');

    waits.length = 0;
    const { operation, calls } = counted(success);
    const second = await withRetry(() => breaker.call(operation), { sleep });
    expect(second).toMatchObject({ ok: false, error: { kind: 'circuit_open' } });
    expect(calls()).toBe(0);
    expect(waits).toEqual([]);
  });
});
