// Test doubles shared by transport and startup tests: fake EventSource, fake WebSocket, in-memory id store,
// and a JSON Response builder. Tests drive them by hand (open, message, error, close).
import type { WsClientMessage } from '../../src/domain/events';
import type { EventSourceLike } from '../../src/transport/sseClient';
import type { DispatcherIdStore, WebSocketLike } from '../../src/transport/wsClient';

// Standard readyState values.
export const CONNECTING = 0;
export const OPEN = 1;
export const SSE_CLOSED = 2;
export const WS_CLOSED = 3;

export class FakeEventSource implements EventSourceLike {
  readyState = CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.readyState = SSE_CLOSED;
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

export class FakeWebSocket implements WebSocketLike {
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
    this.readyState = WS_CLOSED;
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
    this.readyState = WS_CLOSED;
    this.onclose?.(new Event('close'));
  }

  sentOfType(type: WsClientMessage['type']): WsClientMessage[] {
    return this.sent.filter((message) => message.type === type);
  }
}

// In-memory stand-in for sessionStorage.
export function memoryIdStore(initial: string | null = null): DispatcherIdStore & { value: string | null } {
  const store = {
    value: initial,
    load: () => store.value,
    save: (id: string) => {
      store.value = id;
    },
  };
  return store;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
