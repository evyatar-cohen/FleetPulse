// Feature: WebSocket client (registration, keep-alive, reconnect with the same identity)
// Tests:   src/transport/wsClient.ts → WsClient
// Rule:    on open → register (with the saved id if any) → `registered` saves the id and makes the client ready.
//          Ping every 10 s; no pong within 5 s → reconnect. Closed socket / no `registered` within 10 s → reconnect with
//          backoff, re-register with the SAME id, re-send the latest viewed truck (no queue). close() stops everything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsClientMessage, WsServerMessage } from '../../src/domain/events';
import type { ConnectionStatus } from '../../src/transport/connection';
import { WS_DEFAULTS, WsClient, type DispatcherIdStore, type WebSocketLike } from '../../src/transport/wsClient';
import dispatcherJoinedFixture from '../../fixtures/ws/dispatcher_joined.json';
import routeUpdatedFixture from '../../fixtures/ws/route_updated.json';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

// A fake WebSocket the test drives by hand; records what the client sends.
class FakeWebSocket implements WebSocketLike {
  readyState = CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: WsClientMessage[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WsClientMessage);
  }

  close(): void {
    this.readyState = CLOSED;
    this.closed = true;
  }

  emitOpen(): void {
    this.readyState = OPEN;
    this.onopen?.(new Event('open'));
  }

  emitMessage(message: unknown): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  // The server or network closed the socket.
  emitClose(): void {
    this.readyState = CLOSED;
    this.onclose?.(new Event('close'));
  }

  sentOfType(type: WsClientMessage['type']): WsClientMessage[] {
    return this.sent.filter((message) => message.type === type);
  }
}

// In-memory stand-in for sessionStorage.
function memoryIdStore(initial: string | null = null): DispatcherIdStore & { value: string | null } {
  const store = {
    value: initial,
    load: () => store.value,
    save: (id: string) => {
      store.value = id;
    },
  };
  return store;
}

let sockets: FakeWebSocket[];
let messages: WsServerMessage[];
let statuses: ConnectionStatus[];
let clock: number;

function makeClient(idStore: DispatcherIdStore = memoryIdStore()): WsClient {
  return new WsClient({
    url: 'ws://localhost:5173/ws',
    name: 'Alice',
    idStore,
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    onMessage: (message) => messages.push(message),
    onStatusChange: (status) => statuses.push(status),
    now: () => clock,
  });
}

function latest(): FakeWebSocket {
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error('no WebSocket created');
  return socket;
}

// Open + server confirms registration with the given id.
function openAndRegister(dispatcherId = 'dispatcher_alice'): void {
  latest().emitOpen();
  latest().emitMessage({ type: 'registered', dispatcherId });
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  messages = [];
  statuses = [];
  clock = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WebSocket client — registration', () => {
  it('on open sends register_dispatcher with our name (no id the first time)', () => {
    makeClient().connect();
    latest().emitOpen();
    expect(latest().sent).toEqual([{ type: 'register_dispatcher', name: 'Alice' }]);
  });

  it('`registered` saves the id, marks the client open and notifies', () => {
    const idStore = memoryIdStore();
    const onRegistered = vi.fn();
    const client = new WsClient({
      url: 'ws://x/ws',
      name: 'Alice',
      idStore,
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      onMessage: () => undefined,
      onRegistered,
    });
    client.connect();
    openAndRegister('dispatcher_abc');
    expect(idStore.value).toBe('dispatcher_abc');
    expect(client.id).toBe('dispatcher_abc');
    expect(client.status).toBe('open');
    expect(onRegistered).toHaveBeenCalledWith('dispatcher_abc');
  });

  it('a saved id (page reload) is sent when registering → same identity', () => {
    makeClient(memoryIdStore('dispatcher_saved')).connect();
    latest().emitOpen();
    expect(latest().sent[0]).toEqual({ type: 'register_dispatcher', name: 'Alice', dispatcherId: 'dispatcher_saved' });
  });

  it('no `registered` within 10 s → the attempt failed → reconnect', () => {
    makeClient().connect();
    latest().emitOpen();
    vi.advanceTimersByTime(WS_DEFAULTS.registerTimeoutMs);
    expect(sockets[0]?.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });
});

describe('WebSocket client — messages', () => {
  it('valid server messages are delivered as typed messages; invalid ones are dropped and counted', () => {
    const client = makeClient();
    client.connect();
    openAndRegister();
    latest().emitMessage(dispatcherJoinedFixture);
    latest().emitMessage(routeUpdatedFixture);
    latest().emitMessage('{not json');
    latest().emitMessage({ type: 'unknown_type' });
    expect(messages.map((message) => message.type)).toEqual(['registered', 'dispatcher_joined', 'route_updated']);
    expect(client.stats.dropped).toBe(2);
  });
});

describe('WebSocket client — keep-alive', () => {
  it('pings every 10 s; a pong records the latency and keeps the connection', () => {
    const client = makeClient();
    client.connect();
    openAndRegister();
    vi.advanceTimersByTime(WS_DEFAULTS.pingIntervalMs);
    expect(latest().sentOfType('ping')).toHaveLength(1);
    clock += 42;
    latest().emitMessage({ type: 'pong', timestamp: 1 });
    vi.advanceTimersByTime(WS_DEFAULTS.pongTimeoutMs);
    expect(client.stats.latencyMs).toBe(42);
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe('open');
  });

  it('no pong within 5 s → the socket is dead → reconnect', () => {
    const client = makeClient();
    client.connect();
    openAndRegister();
    vi.advanceTimersByTime(WS_DEFAULTS.pingIntervalMs + WS_DEFAULTS.pongTimeoutMs);
    expect(sockets[0]?.closed).toBe(true);
    expect(client.status).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });
});

describe('WebSocket client — reconnect', () => {
  it('socket closed by the server → reconnect after backoff → re-register with the SAME id', () => {
    makeClient().connect();
    openAndRegister('dispatcher_alice');
    latest().emitClose();
    vi.advanceTimersByTime(1000);
    latest().emitOpen();
    expect(latest().sent[0]).toEqual({ type: 'register_dispatcher', name: 'Alice', dispatcherId: 'dispatcher_alice' });
  });

  it('repeated failures back off 1 s, 2 s, 4 s … capped at 30 s; reset after registering', () => {
    const client = makeClient();
    client.connect();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      latest().emitClose();
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000]);
    expect(client.stats.reconnects).toBe(6);

    openAndRegister();
    latest().emitClose();
    const before = sockets.length;
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(before + 1);
  });
});

describe('WebSocket client — viewing truck (state, not a queue)', () => {
  it('sends viewing_truck right away when ready', () => {
    const client = makeClient();
    client.connect();
    openAndRegister();
    client.setViewingTruck('truck_3');
    expect(latest().sentOfType('viewing_truck')).toEqual([{ type: 'viewing_truck', truckId: 'truck_3' }]);
  });

  it('while disconnected only the LATEST truck is kept and sent once after re-registering', () => {
    const client = makeClient();
    client.connect();
    openAndRegister();
    latest().emitClose();
    client.setViewingTruck('truck_3');
    client.setViewingTruck('truck_5');
    client.setViewingTruck('truck_7');
    vi.advanceTimersByTime(1000);
    openAndRegister();
    expect(latest().sentOfType('viewing_truck')).toEqual([{ type: 'viewing_truck', truckId: 'truck_7' }]);
  });
});

describe('WebSocket client — close', () => {
  it('close() stops everything: socket closed, no pings, no reconnect, late messages ignored', () => {
    const client = makeClient();
    client.connect();
    openAndRegister();
    const socket = latest();
    client.close();
    socket.emitMessage(routeUpdatedFixture);
    vi.advanceTimersByTime(5 * 60_000);
    expect(socket.closed).toBe(true);
    expect(socket.sentOfType('ping')).toHaveLength(0);
    expect(sockets).toHaveLength(1);
    expect(messages.map((message) => message.type)).toEqual(['registered']);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('connect() after close() opens a fresh connection and re-registers with the same id', () => {
    const client = makeClient();
    client.connect();
    openAndRegister('dispatcher_alice');
    client.close();
    client.connect();
    expect(sockets).toHaveLength(2);
    latest().emitOpen();
    expect(latest().sent[0]).toEqual({ type: 'register_dispatcher', name: 'Alice', dispatcherId: 'dispatcher_alice' });
  });
});
