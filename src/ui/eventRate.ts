// Pure helper for the observability panel: messages per second from a running "received" counter.
// We keep (time, counter) samples for the last few seconds and divide the difference by the time between them.
// Why a window and not "since the last second": the server sends telemetry in bursts every 2 s, so a 1 s delta
// jumps between 0 and ~24 — a 10 s window gives a steady, readable number.

export interface CounterSample {
  at: number;
  received: number;
}

export const RATE_WINDOW_MS: number = 10_000;

// Adds the newest sample and drops samples older than the window. Returns a new array (input unchanged).
export function addSample(
  samples: readonly CounterSample[],
  sample: CounterSample,
  windowMs: number = RATE_WINDOW_MS,
): CounterSample[] {
  const kept: CounterSample[] = [];
  for (const existing of samples) {
    if (sample.at - existing.at <= windowMs) kept.push(existing);
  }
  kept.push(sample);
  return kept;
}

// Messages per second between the oldest and newest sample; null until we have two samples over some time.
export function ratePerSecond(samples: readonly CounterSample[]): number | null {
  const oldest = samples[0];
  const newest = samples.at(-1);
  if (oldest === undefined || newest === undefined || newest.at <= oldest.at) return null;
  return ((newest.received - oldest.received) * 1000) / (newest.at - oldest.at);
}
