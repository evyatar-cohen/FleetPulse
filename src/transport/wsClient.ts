// WebSocket client: presence (who's online, who views which truck) and route events, plus alerts and fleet_reset.
// Data flow: WebSocket → JSON parse → Zod (WsServerMessageSchema) → onMessage(typed message) → store.
// Lifecycle: open → send register_dispatcher (with our saved id) → `registered` → ready: ping every 10 s, re-send the
// truck we're viewing. Dead socket (no pong, no `registered`, or closed) → reconnect with backoff, same identity.
import { WsServerMessageSchema, type WsClientMessage, type WsServerMessage } from '../domain/events';
import { backoffDelay, parseMessage, RECONNECT_BACKOFF, type ConnectionStatus } from './connection';

// The part of the browser's WebSocket we use — injected so tests can pass a fake.
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent | Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

// Where our dispatcher id survives a reload (sessionStorage in the app: one dispatcher per tab).
export interface DispatcherIdStore {
  load(): string | null;
  save(dispatcherId: string): void;
}

// WebSocket.readyState OPEN (standard).
const READY_STATE_OPEN = 1;

export interface WsStats {
  received: number;
  dropped: number;
  reconnects: number;
  // Last ping → pong round trip; null until the first pong.
  latencyMs: number | null;
}

export interface WsClientOptions {
  url: string;
  name: string;
  createWebSocket: WebSocketFactory;
  idStore: DispatcherIdStore;
  onMessage: (message: WsServerMessage) => void;
  onRegistered?: (dispatcherId: string) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  // From creating the socket until `registered`; longer → the attempt failed.
  registerTimeoutMs?: number;
  now?: () => number;
}

export const WS_DEFAULTS = {
  pingIntervalMs: 10_000,
  pongTimeoutMs: 5000,
  registerTimeoutMs: 10_000,
} as const;

export class WsClient {
  private readonly options: WsClientOptions;
  private readonly now: () => number;
  private socket: WebSocketLike | null = null;
  private registered = false;
  private dispatcherId: string | null = null;
  private viewingTruckId: string | null = null;
  private failedAttempts = 0;
  private currentStatus: ConnectionStatus = 'idle';
  private pingSentAt: number | null = null;
  private registerTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly counters: WsStats = { received: 0, dropped: 0, reconnects: 0, latencyMs: null };

  constructor(options: WsClientOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get stats(): WsStats {
    return { ...this.counters };
  }

  get id(): string | null {
    return this.dispatcherId;
  }

  connect(): void {
    if (this.currentStatus !== 'idle' && this.currentStatus !== 'closed') {
      return;
    }
    this.failedAttempts = 0;
    this.open();
  }

  close(): void {
    this.teardownSocket();
    this.clearTimer('reconnect');
    this.setStatus('closed');
  }

  // Presence: remember the latest truck we view; send it now if ready, otherwise after (re)registering.
  setViewingTruck(truckId: string): void {
    this.viewingTruckId = truckId;
    if (this.registered) {
      this.send({ type: 'viewing_truck', truckId });
    }
  }

  private open(): void {
    this.setStatus(this.failedAttempts === 0 ? 'connecting' : 'reconnecting');
    const socket = this.options.createWebSocket(this.options.url);
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onclose = () => this.scheduleReconnect();
    // An error is always followed by close — handled there.
    socket.onerror = null;
    this.socket = socket;
    this.registerTimer = setTimeout(() => this.scheduleReconnect(), this.timing('registerTimeoutMs'));
  }

  private handleOpen(): void {
    const savedId = this.options.idStore.load();
    const register: WsClientMessage = { type: 'register_dispatcher', name: this.options.name };
    if (savedId !== null) {
      register.dispatcherId = savedId;
    }
    this.send(register);
  }

  private handleMessage(event: MessageEvent): void {
    const message = parseMessage(WsServerMessageSchema, event.data);
    if (message === null) {
      this.counters.dropped++;
      return;
    }
    this.counters.received++;
    if (message.type === 'registered') {
      this.handleRegistered(message.dispatcherId);
    } else if (message.type === 'pong') {
      this.handlePong();
    }
    this.options.onMessage(message);
  }

  private handleRegistered(dispatcherId: string): void {
    this.clearTimer('register');
    this.registered = true;
    this.failedAttempts = 0;
    this.dispatcherId = dispatcherId;
    this.options.idStore.save(dispatcherId);
    this.setStatus('open');
    this.startPinging();
    if (this.viewingTruckId !== null) {
      this.send({ type: 'viewing_truck', truckId: this.viewingTruckId });
    }
    this.options.onRegistered?.(dispatcherId);
  }

  private startPinging(): void {
    this.pingTimer = setInterval(() => {
      this.pingSentAt = this.now();
      this.send({ type: 'ping' });
      this.clearTimer('pong');
      // No pong in time → the socket is dead even if it looks open.
      this.pongTimer = setTimeout(() => this.scheduleReconnect(), this.timing('pongTimeoutMs'));
    }, this.timing('pingIntervalMs'));
  }

  private handlePong(): void {
    this.clearTimer('pong');
    if (this.pingSentAt !== null) {
      this.counters.latencyMs = this.now() - this.pingSentAt;
      this.pingSentAt = null;
    }
  }

  private send(message: WsClientMessage): void {
    if (this.socket !== null && this.socket.readyState === READY_STATE_OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(): void {
    this.teardownSocket();
    this.clearTimer('reconnect');
    this.setStatus('reconnecting');
    const delay = backoffDelay(this.failedAttempts, RECONNECT_BACKOFF.initialMs, RECONNECT_BACKOFF.maxMs);
    this.failedAttempts++;
    this.counters.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private teardownSocket(): void {
    this.clearTimer('register');
    this.clearTimer('ping');
    this.clearTimer('pong');
    this.registered = false;
    this.pingSentAt = null;
    if (this.socket !== null) {
      // Detach handlers first so late events (including its own close) are ignored.
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }
  }

  private clearTimer(which: 'register' | 'ping' | 'pong' | 'reconnect'): void {
    if (which === 'register' && this.registerTimer !== null) {
      clearTimeout(this.registerTimer);
      this.registerTimer = null;
    } else if (which === 'ping' && this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    } else if (which === 'pong' && this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    } else if (which === 'reconnect' && this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private timing(key: keyof typeof WS_DEFAULTS): number {
    return this.options[key] ?? WS_DEFAULTS[key];
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.options.onStatusChange?.(status);
  }
}
