// Feature: Throttled rendering (performance — redraw at most once per second)
// Tests:   src/ui/throttle.ts → createThrottle()
// Rule:    the first change runs immediately; changes during the interval collapse into ONE trailing run at the end;
//          the latest change is never lost; cancel() drops a pending run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottle } from '../../src/ui/throttle';

const INTERVAL = 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Throttle', () => {
  it('the first change runs immediately', () => {
    const callback = vi.fn();
    createThrottle(callback, INTERVAL).trigger();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('a burst of changes (e.g. a 30-reading GPS batch) → one immediate run + one trailing run', () => {
    const callback = vi.fn();
    const throttle = createThrottle(callback, INTERVAL);
    for (let i = 0; i < 30; i++) {
      throttle.trigger();
    }
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTERVAL);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('steady updates every 100 ms → at most one run per second', () => {
    const callback = vi.fn();
    const throttle = createThrottle(callback, INTERVAL);
    for (let i = 0; i < 50; i++) {
      throttle.trigger();
      vi.advanceTimersByTime(100);
    }
    // 5 seconds of updates → ~5–6 runs, never 50.
    expect(callback.mock.calls.length).toBeLessThanOrEqual(6);
    expect(callback.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('a change after a quiet period runs immediately again', () => {
    const callback = vi.fn();
    const throttle = createThrottle(callback, INTERVAL);
    throttle.trigger();
    vi.advanceTimersByTime(5000);
    throttle.trigger();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('cancel() drops the pending trailing run (component unmounted)', () => {
    const callback = vi.fn();
    const throttle = createThrottle(callback, INTERVAL);
    throttle.trigger();
    throttle.trigger();
    throttle.cancel();
    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
