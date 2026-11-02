// Circuit breaker (bonus): stops calling an unhealthy server for a while, then probes for recovery.
// Used around GET /api/fleet, inside retry: withRetry(() => breaker.call(() => rest.getFleet())), so every request
// is counted and an open breaker answers instantly.
//
//   CLOSED ──N failures in a row──► OPEN ──cooldown over──► HALF_OPEN ──probe ok──► CLOSED
//                                    ▲                          │ probe fails
//                                    └──────────────────────────┘
//
// Passive: no timers of its own — it decides on each call. The clock is injected so tests control time.
import { err, type Result } from '../domain/result';
import type { ApiError, ApiResult } from './restClient';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now: () => number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  cooldownMs: 10_000,
  now: () => Date.now(),
};

// "The server isn't healthy" — same list retry treats as temporary. Any other answer means the server responded.
function isHealthFailure(result: Result<unknown, ApiError>): boolean {
  if (result.ok) return false;
  const kind = result.error.kind;
  return kind === 'unavailable' || kind === 'network' || kind === 'timeout';
}

export class CircuitBreaker {
  private readonly options: CircuitBreakerOptions;
  private consecutiveFailures = 0;
  // Set while open (and during the probe); null when closed.
  private openUntilMs: number | null = null;
  private probeInFlight = false;

  constructor(overrides: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...overrides };
  }

  get state(): CircuitState {
    if (this.openUntilMs === null) return 'closed';
    if (this.options.now() < this.openUntilMs) return 'open';
    return 'half_open';
  }

  // When the cooldown ends (the caller can schedule its next call for then). null when closed.
  get openUntil(): number | null {
    return this.openUntilMs;
  }

  async call<T>(operation: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const state = this.state;
    if (state === 'open' || (state === 'half_open' && this.probeInFlight)) {
      return err({ kind: 'circuit_open', retryAtMs: this.openUntilMs ?? this.options.now() });
    }

    const isProbe = state === 'half_open';
    if (isProbe) this.probeInFlight = true;
    try {
      const result = await operation();
      this.record(result);
      return result;
    } finally {
      if (isProbe) this.probeInFlight = false;
    }
  }

  private record(result: Result<unknown, ApiError>): void {
    if (!isHealthFailure(result)) {
      this.consecutiveFailures = 0;
      this.openUntilMs = null;
      return;
    }
    this.consecutiveFailures++;
    // A failed probe re-opens immediately; otherwise open once the threshold is reached.
    const wasOpen = this.openUntilMs !== null;
    if (wasOpen || this.consecutiveFailures >= this.options.failureThreshold) {
      this.openUntilMs = this.options.now() + this.options.cooldownMs;
    }
  }
}
