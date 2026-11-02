// Feature: Retry for reads (QUIRK #7 — 503 with Retry-After)
// Tests:   src/transport/retry.ts → withRetry()
// Rule:    retry only temporary errors (503, network, timeout), at most 3 attempts in total.
//          Wait = Retry-After when the server sends it, otherwise exponential backoff (1 s, 2 s, …).
//          A requested wait above 10 s → stop and return the error (the circuit breaker handles long outages).
import { describe, expect, it } from 'vitest';
import { err, ok } from '../../src/domain/result';
import type { ApiError, ApiResult } from '../../src/transport/restClient';
import { withRetry } from '../../src/transport/retry';

// An operation that returns the given results in order and counts calls.
function scripted<T>(...results: ApiResult<T>[]): { operation: () => Promise<ApiResult<T>>; calls: () => number } {
  let count = 0;
  const operation = async (): Promise<ApiResult<T>> => {
    const next = results[count];
    count++;
    if (next === undefined) throw new Error('scripted: no more results');
    return next;
  };
  return { operation, calls: () => count };
}

// Fake sleep: records requested waits instead of waiting.
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  return { sleep, waits };
}

const busy = (retryAfterMs: number | null): ApiResult<string> => err({ kind: 'unavailable', retryAfterMs });
const failWith = (error: ApiError): ApiResult<string> => err(error);

describe('Retry for reads', () => {
  it('success on the first try → no wait, one call', async () => {
    const { operation, calls } = scripted(ok('fleet'));
    const { sleep, waits } = recordingSleep();
    expect(await withRetry(operation, { sleep })).toEqual(ok('fleet'));
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('503 then success → waits Retry-After (3 s) and returns the data', async () => {
    const { operation, calls } = scripted(busy(3000), ok('fleet'));
    const { sleep, waits } = recordingSleep();
    expect(await withRetry(operation, { sleep })).toEqual(ok('fleet'));
    expect(calls()).toBe(2);
    expect(waits).toEqual([3000]);
  });

  it('503 three times → gives up after 3 attempts and returns the last error', async () => {
    const { operation, calls } = scripted(busy(3000), busy(3000), busy(3000), ok('never reached'));
    const { sleep, waits } = recordingSleep();
    expect(await withRetry(operation, { sleep })).toEqual(busy(3000));
    expect(calls()).toBe(3);
    expect(waits).toEqual([3000, 3000]);
  });

  it('503 without Retry-After → exponential backoff (1 s, then 2 s)', async () => {
    const { operation } = scripted(busy(null), busy(null), ok('fleet'));
    const { sleep, waits } = recordingSleep();
    await withRetry(operation, { sleep });
    expect(waits).toEqual([1000, 2000]);
  });

  it('network error and timeout are retried with backoff', async () => {
    const { operation } = scripted(
      failWith({ kind: 'network', message: 'Failed to fetch' }),
      failWith({ kind: 'timeout' }),
      ok('fleet'),
    );
    const { sleep, waits } = recordingSleep();
    expect(await withRetry(operation, { sleep })).toEqual(ok('fleet'));
    expect(waits).toEqual([1000, 2000]);
  });

  it.each<ApiError>([
    { kind: 'not_found', message: 'Truck not found' },
    { kind: 'invalid_response', status: 200, message: 'bad shape' },
    { kind: 'unauthorized', message: 'X-Dispatcher-Id header required' },
    { kind: 'version_conflict', body: { error: 'modified', currentVersion: 2 } },
  ])('non-temporary error $kind → no retry', async (error) => {
    const { operation, calls } = scripted(failWith(error));
    const { sleep, waits } = recordingSleep();
    expect(await withRetry(operation, { sleep })).toEqual(failWith(error));
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('Retry-After above the 10 s cap → no waiting, the error is returned immediately', async () => {
    const { operation, calls } = scripted(busy(3_600_000), ok('never reached'));
    const { sleep, waits } = recordingSleep();
    expect(await withRetry(operation, { sleep })).toEqual(busy(3_600_000));
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('max attempts is configurable', async () => {
    const { operation, calls } = scripted(busy(1000), busy(1000), busy(1000), busy(1000), ok('fleet'));
    const { sleep } = recordingSleep();
    expect(await withRetry(operation, { sleep, maxAttempts: 5 })).toEqual(ok('fleet'));
    expect(calls()).toBe(5);
  });
});
