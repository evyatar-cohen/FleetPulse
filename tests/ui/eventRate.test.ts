// Feature: Observability panel — SSE messages per second
// Tests:   src/ui/eventRate.ts → addSample(), ratePerSecond()
// Rule:    rate = counter difference / time difference over the last 10 s; old samples are dropped (bounded memory).
import { describe, expect, it } from 'vitest';
import { addSample, ratePerSecond, type CounterSample } from '../../src/ui/eventRate';

function collect(points: Array<[number, number]>): CounterSample[] {
  let samples: CounterSample[] = [];
  for (const [at, received] of points) samples = addSample(samples, { at, received });
  return samples;
}

describe('Event rate over a sliding window', () => {
  it('bursts of 12 every 2 s → a steady 6 messages/s', () => {
    const samples = collect([[0, 0], [1000, 12], [2000, 12], [3000, 24], [4000, 24]]);
    expect(ratePerSecond(samples)).toBe(6);
  });

  it('samples older than the window are dropped, so the rate follows recent traffic', () => {
    // At 16 s the samples from 0 s and 5 s are older than 10 s → only the quiet recent period counts.
    const samples = collect([[0, 0], [5_000, 1000], [15_000, 1000], [16_000, 1010]]);
    expect(samples.map((sample) => sample.at)).toEqual([15_000, 16_000]);
    expect(ratePerSecond(samples)).toBe(10);
  });

  it('no rate until there are two samples at different times', () => {
    expect(ratePerSecond([])).toBeNull();
    expect(ratePerSecond(collect([[1000, 5]]))).toBeNull();
  });
});
