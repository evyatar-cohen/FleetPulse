// Dispatcher presence: who is online, their names, and which truck each one is viewing.
// Data flow: WS dispatcher_joined / dispatcher_left / dispatcher_viewing → applyPresenceMessage() → store → UI.
//
// QUIRK #6 (ghost presence): a `dispatcher_left` can arrive ~10 s late — even after the same id reconnected. Timestamps
// can't detect it (the stale leave is NEWER than the rejoin). So we count open connections per id: the server sends
// exactly one joined and one left per socket → online while the count is > 0 (like reference counting).
// Leaves about OURSELVES are ignored (our own ghost leave can arrive after we reconnect with the same id).
// Who joined BEFORE us: the server never lists them, so every client answers a dispatcher_joined by re-sending its
// viewing_truck (empty truckId = not viewing) — the newcomer learns about them from those dispatcher_viewing messages.
// Pure functions: no I/O, no store, no React.
import type { WsServerMessage } from './events';

export interface DispatcherPresence {
  id: string;
  // From dispatcher_joined; null if we only saw them viewing a truck.
  name: string | null;
  // Open connections we know of (joined − left). Online while > 0.
  connections: number;
  viewingTruckId: string | null;
}

export type Presence = Readonly<Record<string, DispatcherPresence>>;

export type PresenceMessage = Extract<WsServerMessage, { type: 'dispatcher_joined' | 'dispatcher_left' | 'dispatcher_viewing' }>;

export function isPresenceMessage(message: WsServerMessage): message is PresenceMessage {
  return message.type === 'dispatcher_joined' || message.type === 'dispatcher_left' || message.type === 'dispatcher_viewing';
}

function withDispatcher(presence: Presence, dispatcher: DispatcherPresence): Presence {
  return { ...presence, [dispatcher.id]: dispatcher };
}

function without(presence: Presence, dispatcherId: string): Presence {
  const next: Record<string, DispatcherPresence> = { ...presence };
  delete next[dispatcherId];
  return next;
}

// `myDispatcherId`: our own id — never listed as "another dispatcher", and its leaves are ignored.
export function applyPresenceMessage(presence: Presence, message: PresenceMessage, myDispatcherId: string | null): Presence {
  if (message.type === 'dispatcher_joined') {
    if (message.dispatcherId === myDispatcherId) return presence;
    const existing = presence[message.dispatcherId];
    return withDispatcher(presence, {
      id: message.dispatcherId,
      name: message.name,
      connections: (existing?.connections ?? 0) + 1,
      viewingTruckId: existing?.viewingTruckId ?? null,
    });
  }

  if (message.type === 'dispatcher_left') {
    // Our own (possibly ghost) leave: we're obviously still here.
    if (message.dispatcherId === myDispatcherId) return presence;
    const existing = presence[message.dispatcherId];
    // A leave for someone we don't know (e.g. their announce never reached us) — nothing to remove.
    if (existing === undefined) return presence;
    const connections = existing.connections - 1;
    // QUIRK #6: still > 0 → this was a late (ghost) leave of an older connection; they are back online.
    if (connections > 0) return withDispatcher(presence, { ...existing, connections });
    return without(presence, message.dispatcherId);
  }

  // dispatcher_viewing — the sender is evidently online. dispatcherId is null if they never registered.
  const dispatcherId = message.dispatcherId;
  if (dispatcherId === null || dispatcherId === myDispatcherId) return presence;
  // Empty truckId = "online, not viewing a truck" (our announce convention, see transport/wsClient.ts).
  const viewingTruckId = message.truckId === '' ? null : message.truckId;
  const existing = presence[dispatcherId];
  if (existing !== undefined && existing.viewingTruckId === viewingTruckId) return presence;
  return withDispatcher(presence, {
    id: dispatcherId,
    name: existing?.name ?? null,
    // Someone we never saw join (they connected before us): count this connection so their leave removes them.
    connections: existing === undefined ? 1 : existing.connections,
    viewingTruckId,
  });
}

// Names stay known after a dispatcher leaves (history and routes still mention them). Same object if unchanged.
export function rememberName(names: Readonly<Record<string, string>>, message: PresenceMessage): Readonly<Record<string, string>> {
  if (message.type !== 'dispatcher_joined' || names[message.dispatcherId] === message.name) return names;
  return { ...names, [message.dispatcherId]: message.name };
}

// Other dispatchers currently viewing this truck.
export function viewersOf(presence: Presence, truckId: string): DispatcherPresence[] {
  return Object.values(presence).filter((dispatcher) => dispatcher.viewingTruckId === truckId);
}
