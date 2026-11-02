// Feature: SSE client (live telemetry connection lifecycle)
// Tests:   src/transport/sseClient.ts → SseClient
// Rule:    valid messages → typed events; invalid → dropped + counted (no crash). If the browser gives up (CLOSED) or
//          nothing arrives for 20 s (dead connection / hanging attempt) → reconnect with backoff 1 s, 2 s, 4 s… ≤ 30 s,
//          reset after a successful open. close() stops everything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseEvent } from '../../src/domain/events';
import { SSE_DEFAULTS, SseClient, type ConnectionStatus, type EventSourceLike } from '../../src/transport/sseClient';
import batchFixture from '../../fixtures/sse/gps_batch.json';
import heartbeatFixture from '../../fixtures/sse/heartbeat.json';
import telemetryFixture from '../../fixtures/sse/telemetry.json';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

// A fake EventSource the test drives by hand.
class FakeEventSource implements EventSourceLike {
  readyState = CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.readyState = CLOSED;
    this.closed = true;
  }

  emitOpen(): void {
    this.readyState = OPEN;
    this.onopen?.(new Event('open'));
  }

  emitMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.(new MessageEvent('message', { data: text }));
  }

  emitError(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }
}

let sources: FakeEventSource[];
let events: SseEvent[];
let statuses: ConnectionStatus[];

function makeClient(): SseClient {
  return new SseClient({
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    onEvent: (event) => events.push(event),
    onStatusChange: (status) => statuses.push(status),
  });
}

function latest(): FakeEventSource {
  const source = sources.at(-1);
  if (source === undefined) throw new Error('no EventSource created');
  return source;
}

beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  events = [];
  statuses = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SSE client — messages', () => {
  it('connects to the telemetry stream and reports connecting → open', () => {
    const client = makeClient();
    client.connect();
    latest().emitOpen();
    expect(latest().url).toBe('/api/telemetry/stream');
    expect(statuses).toEqual(['connecting', 'open']);
    expect(client.status).toBe('open');
  });

  it('valid telemetry, batch and heartbeat messages are delivered as typed events', () => {
    const client = makeClient();
    client.connect();
    latest().emitOpen();
    latest().emitMessage(telemetryFixture);
    latest().emitMessage(batchFixture);
    latest().emitMessage(heartbeatFixture);
    expect(events.map((event) => event.type)).toEqual(['telemetry', 'gps_batch', 'heartbeat']);
    expect(client.stats.received).toBe(3);
  });

  it('invalid JSON or an unknown shape is dropped and counted — no crash, no event', () => {
    const client = makeClient();
    client.connect();
    latest().emitOpen();
    latest().emitMessage('{not json');
    latest().emitMessage({ type: 'teleport' });
    expect(events).toEqual([]);
    expect(client.stats.dropped).toBe(2);
  });
});

describe('SSE client — reconnect', () => {
  it('transient error: the browser drops back to CONNECTING and retries by itself → status reconnecting, no new connection from us', () => {
    const client = makeClient();
    client.connect();
    latest().emitOpen();
    latest().emitError(CONNECTING);
    expect(client.status).toBe('reconnecting');
    expect(sources).toHaveLength(1);
  });

  it('browser gave up (CLOSED) → we open a new connection after 1 s', () => {
    const client = makeClient();
    client.connect();
    latest().emitError(CLOSED);
    vi.advanceTimersByTime(999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.closed).toBe(true);
  });

  it('repeated failures back off 1 s, 2 s, 4 s … capped at 30 s', () => {
    const client = makeClient();
    client.connect();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      latest().emitError(CLOSED);
      const before = sources.length;
      let waited = 0;
      while (sources.length === before) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(client.stats.reconnects).toBe(7);
  });

  it('a successful open resets the backoff to 1 s', () => {
    const client = makeClient();
    client.connect();
    latest().emitError(CLOSED);
    vi.advanceTimersByTime(1000);
    latest().emitError(CLOSED);
    vi.advanceTimersByTime(2000);
    latest().emitOpen();
    latest().emitError(CLOSED);
    const before = sources.length;
    vi.advanceTimersByTime(1000);
    expect(sources.length).toBe(before + 1);
  });
});

describe('SSE client — dead connection watchdog (heartbeat)', () => {
  it('heartbeats every 15 s keep the connection alive', () => {
    const client = makeClient();
    client.connect();
    latest().emitOpen();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(15_000);
      latest().emitMessage(heartbeatFixture);
    }
    expect(sources).toHaveLength(1);
    expect(client.status).toBe('open');
  });

  it('nothing for 20 s while "open" → treated as dead: closed, reconnecting, new connection after backoff', () => {
    const client = makeClient();
    client.connect();
    latest().emitOpen();
    vi.advanceTimersByTime(SSE_DEFAULTS.watchdogTimeoutMs);
    expect(sources[0]?.closed).toBe(true);
    expect(client.status).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
  });

  it('an attempt that hangs and never opens is also caught by the watchdog', () => {
    const client = makeClient();
    client.connect();
    vi.advanceTimersByTime(SSE_DEFAULTS.watchdogTimeoutMs + 1000);
    expect(sources).toHaveLength(2);
  });
});

describe('SSE client — close', () => {
  it('close() stops everything: connection closed, no reconnect later, late events ignored', () => {
    const client = makeClient();
    client.connect();
    latest().emitOpen();
    const old = latest();
    client.close();
    old.emitMessage(telemetryFixture);
    vi.advanceTimersByTime(5 * 60_000);
    expect(old.closed).toBe(true);
    expect(sources).toHaveLength(1);
    expect(events).toEqual([]);
    expect(client.status).toBe('closed');
  });

  it('connect() twice does not open a second connection', () => {
    const client = makeClient();
    client.connect();
    client.connect();
    expect(sources).toHaveLength(1);
  });

  it('connect() after close() opens a fresh connection (e.g. component remount)', () => {
    const client = makeClient();
    client.connect();
    latest().emitOpen();
    client.close();
    client.connect();
    expect(sources).toHaveLength(2);
    latest().emitOpen();
    expect(client.status).toBe('open');
  });
});
