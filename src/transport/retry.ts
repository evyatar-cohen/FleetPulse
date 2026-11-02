// Automatic retry for READ requests (idempotent — safe to repeat). Never wrap a write with this.
// Data flow: caller → withRetry(() => rest.getFleet()) → retries temporary failures → Result back to the caller.
// QUIRK #7: GET /api/fleet answers 503 with Retry-After ~15% of the time.
import type { ApiError, ApiResult } from './restClient';

export interface RetryOptions {
  // Total attempts, including the first one.
  maxAttempts: number;
  // First backoff wait when the server gives no Retry-After; doubles on each retry (1 s, 2 s, 4 s…).
  baseBackoffMs: number;
  // If the server asks us to wait longer than this, give up now rather than leave the UI hanging.
  maxWaitMs: number;
  // Injected so tests don't really wait.
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseBackoffMs: 1000,
  maxWaitMs: 10_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Temporary failures: the same request may succeed in a moment.
function isTemporary(error: ApiError): boolean {
  return error.kind === 'unavailable' || error.kind === 'network' || error.kind === 'timeout';
}

// Respect the server's Retry-After when it sent one; otherwise exponential backoff.
// `retryNumber` starts at 0 for the first retry.
function waitBeforeRetry(error: ApiError, retryNumber: number, options: RetryOptions): number {
  if (error.kind === 'unavailable' && error.retryAfterMs !== null) {
    return error.retryAfterMs;
  }
  return options.baseBackoffMs * 2 ** retryNumber;
}

export async function withRetry<T>(
  operation: () => Promise<ApiResult<T>>,
  overrides: Partial<RetryOptions> = {},
): Promise<ApiResult<T>> {
  const options: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...overrides };

  let result = await operation();
  for (let retryNumber = 0; retryNumber < options.maxAttempts - 1; retryNumber++) {
    if (result.ok || !isTemporary(result.error)) {
      return result;
    }
    const waitMs = waitBeforeRetry(result.error, retryNumber, options);
    if (waitMs > options.maxWaitMs) {
      return result;
    }
    await options.sleep(waitMs);
    result = await operation();
  }
  return result;
}
