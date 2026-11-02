// Shared by the live-connection clients (SSE, WebSocket): connection status, reconnect backoff, message parsing.
import type { z } from 'zod';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export const RECONNECT_BACKOFF = {
  initialMs: 1000,
  maxMs: 30_000,
} as const;

// Exponential backoff with a cap: 1 s, 2 s, 4 s … up to maxMs. `failedAttempts` starts at 0.
export function backoffDelay(
  failedAttempts: number,
  initialMs: number = RECONNECT_BACKOFF.initialMs,
  maxMs: number = RECONNECT_BACKOFF.maxMs,
): number {
  return Math.min(initialMs * 2 ** failedAttempts, maxMs);
}

// Untrusted input from a live connection: invalid JSON or an unknown shape → null (dropped), never an exception.
export function parseMessage<T>(schema: z.ZodType<T>, data: unknown): T | null {
  if (typeof data !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : null;
}
