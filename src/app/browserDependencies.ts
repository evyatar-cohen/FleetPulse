// The real browser implementations handed to startApp(): fetch, EventSource, WebSocket, sessionStorage.
// Tests pass fakes instead (see tests/helpers/fakes.ts) — this file is the only place that touches the browser APIs.
import type { DispatcherIdStore } from '../transport/wsClient';
import type { AppDependencies } from './startup';

const DISPATCHER_ID_KEY = 'fleetpulse.dispatcherId';
const DISPATCHER_NAME_KEY = 'fleetpulse.dispatcherName';

// sessionStorage can throw (blocked storage, private mode) — then we simply don't remember.
function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Not fatal: the next reload registers as a new dispatcher.
  }
}

// One dispatcher identity per tab, kept across reloads (two tabs = two dispatchers, for conflict testing).
const sessionIdStore: DispatcherIdStore = {
  load: () => readSession(DISPATCHER_ID_KEY),
  save: (dispatcherId) => writeSession(DISPATCHER_ID_KEY, dispatcherId),
};

export function loadDispatcherName(): string | null {
  return readSession(DISPATCHER_NAME_KEY);
}

export function saveDispatcherName(name: string): void {
  writeSession(DISPATCHER_NAME_KEY, name);
}

export function browserDependencies(): AppDependencies {
  // Same host as the page (the Vite dev proxy forwards /ws to the mock server).
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    fetch: (url, init) => window.fetch(url, init),
    createEventSource: (url) => new EventSource(url),
    createWebSocket: (url) => new WebSocket(url),
    idStore: sessionIdStore,
    wsUrl: `${protocol}//${window.location.host}/ws`,
  };
}
