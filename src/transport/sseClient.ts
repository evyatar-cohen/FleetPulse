// SSE client: receives live telemetry from GET /api/telemetry/stream.
// Data flow: EventSource → JSON parse → Zod (SseEventSchema) → onEvent(typed event) → store → domain pipeline.
// Adds what EventSource lacks: a watchdog for silent ("open but dead") connections, and reconnecting by ourselves
// (exponential backoff) when the browser gives up. Invalid messages are dropped and counted, never thrown.
import { SseEventSchema, type SseEvent } from '../domain/events';
import { backoffDelay, parseMessage, RECONNECT_BACKOFF, type ConnectionStatus } from './connection';

export type { ConnectionStatus } from './connection';

// The part of the browser's EventSource we use — injected so tests can pass a fake.
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

// EventSource.readyState values (standard).
const READY_STATE_CLOSED = 2;

export interface SseStats {
  received: number;
  dropped: number;
  reconnects: number;
}

export interface SseClientOptions {
  createEventSource: EventSourceFactory;
  onEvent: (event: SseEvent) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  url?: string;
  // No message (heartbeat, telemetry, batch) for this long → connection is dead. Heartbeat every 15 s + margin.
  watchdogTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export const SSE_DEFAULTS = {
  url: '/api/telemetry/stream',
  watchdogTimeoutMs: 20_000,
  initialBackoffMs: RECONNECT_BACKOFF.initialMs,
  maxBackoffMs: RECONNECT_BACKOFF.maxMs,
} as const;

export class SseClient {
  private readonly options: Required<Omit<SseClientOptions, 'onStatusChange'>> &
    Pick<SseClientOptions, 'onStatusChange'>;
  private source: EventSourceLike | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failedAttempts = 0;
  private currentStatus: ConnectionStatus = 'idle';
  private readonly counters: SseStats = { received: 0, dropped: 0, reconnects: 0 };

  constructor(options: SseClientOptions) {
    this.options = { ...SSE_DEFAULTS, ...options };
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get stats(): SseStats {
    return { ...this.counters };
  }

  connect(): void {
    if (this.currentStatus !== 'idle' && this.currentStatus !== 'closed') {
      return;
    }
    this.failedAttempts = 0;
    this.open();
  }

  // Stops everything: no reconnects, no timers, late events from the old connection are ignored.
  close(): void {
    this.teardownSource();
    this.clearReconnectTimer();
    this.setStatus('closed');
  }

  private open(): void {
    this.setStatus(this.failedAttempts === 0 ? 'connecting' : 'reconnecting');
    const source = this.options.createEventSource(this.options.url);
    source.onopen = () => this.handleOpen();
    source.onmessage = (event) => this.handleMessage(event);
    source.onerror = () => this.handleError(source);
    this.source = source;
    // Also covers an attempt that hangs and never opens.
    this.resetWatchdog();
  }

  private handleOpen(): void {
    this.failedAttempts = 0;
    this.setStatus('open');
    this.resetWatchdog();
  }

  private handleMessage(event: MessageEvent): void {
    this.resetWatchdog();
    const parsed = parseMessage(SseEventSchema, event.data);
    if (parsed === null) {
      this.counters.dropped++;
      return;
    }
    this.counters.received++;
    this.options.onEvent(parsed);
  }

  private handleError(source: EventSourceLike): void {
    if (source.readyState === READY_STATE_CLOSED) {
      // The browser gave up (e.g. an error status) — it won't retry, so we do.
      this.scheduleReconnect();
      return;
    }
    // The browser is retrying by itself; the watchdog catches it if that never succeeds.
    this.setStatus('reconnecting');
  }

  private scheduleReconnect(): void {
    this.teardownSource();
    this.clearReconnectTimer();
    this.setStatus('reconnecting');
    const delay = backoffDelay(this.failedAttempts, this.options.initialBackoffMs, this.options.maxBackoffMs);
    this.failedAttempts++;
    this.counters.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    // Dead connection (or hanging attempt): nothing received for too long.
    this.watchdogTimer = setTimeout(() => this.scheduleReconnect(), this.options.watchdogTimeoutMs);
  }

  private teardownSource(): void {
    this.clearWatchdog();
    if (this.source !== null) {
      // Detach handlers first so late events from the old connection are ignored.
      this.source.onopen = null;
      this.source.onmessage = null;
      this.source.onerror = null;
      this.source.close();
      this.source = null;
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.options.onStatusChange?.(status);
  }
}
