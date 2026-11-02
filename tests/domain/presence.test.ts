// Feature: Dispatcher presence with ghost handling (QUIRK #6)
// Tests:   src/domain/presence.ts → applyPresenceMessage(), rememberName(), viewersOf()
// Rule:    online while (joined − left) > 0 per id, so a late "ghost" leave after a reconnect doesn't remove someone who
//          is back; leaves about ourselves are ignored; a leave for an unknown id changes nothing.
import { describe, expect, it } from 'vitest';
import { WsServerMessageSchema } from '../../src/domain/events';
import {
  applyPresenceMessage,
  isPresenceMessage,
  rememberName,
  viewersOf,
  type Presence,
  type PresenceMessage,
} from '../../src/domain/presence';
import ghostFixture from '../../fixtures/ws/ghost_reconnect_sequence.json';

const ME = 'dispatcher_me';

function joined(id: string, name: string): PresenceMessage {
  return { type: 'dispatcher_joined', dispatcherId: id, name, timestamp: 1, activeDispatchers: 2 };
}

function left(id: string): PresenceMessage {
  return { type: 'dispatcher_left', dispatcherId: id, timestamp: 1, activeDispatchers: 1 };
}

function viewing(id: string | null, truckId: string): PresenceMessage {
  return { type: 'dispatcher_viewing', dispatcherId: id, truckId, timestamp: 1 };
}

function apply(...messages: PresenceMessage[]): Presence {
  let presence: Presence = {};
  for (const message of messages) presence = applyPresenceMessage(presence, message, ME);
  return presence;
}

describe('Presence — normal join and leave', () => {
  it('a joined dispatcher is online with their name', () => {
    expect(apply(joined('bob', 'Bob'))['bob']).toEqual({ id: 'bob', name: 'Bob', connections: 1, viewingTruckId: null });
  });

  it('a leave removes them', () => {
    expect(apply(joined('bob', 'Bob'), left('bob'))).toEqual({});
  });
});

describe('Presence — ghost leave (QUIRK #6)', () => {
  it('close → reconnect with the same id → late leave of the OLD connection: still online', () => {
    // joined (1) → [socket closes, leave delayed 10 s] → joined again (2) → ghost left (1)
    const presence = apply(joined('carol', 'Carol'), joined('carol', 'Carol'), left('carol'));
    expect(presence['carol']?.connections).toBe(1);
  });

  it('…and her real leave later takes her offline', () => {
    const presence = apply(joined('carol', 'Carol'), joined('carol', 'Carol'), left('carol'), left('carol'));
    expect(presence['carol']).toBeUndefined();
  });

  it('real captured sequence: Carol reconnected, then the 10 s late leave arrived — the UI does not break, no negative count', () => {
    let presence: Presence = apply(joined('dispatcher_fixture_carol', 'Carol'));
    for (const entry of ghostFixture.observed) {
      const message = WsServerMessageSchema.parse(entry.msg);
      if (!isPresenceMessage(message)) throw new Error('fixture');
      presence = applyPresenceMessage(presence, message, ME);
    }
    expect(presence['dispatcher_fixture_carol']).toMatchObject({ name: 'Carol', connections: 1 });
  });

  it('a leave about OURSELVES (our own ghost after we reconnected) is ignored', () => {
    const presence = apply(joined('bob', 'Bob'));
    expect(applyPresenceMessage(presence, left(ME), ME)).toBe(presence);
  });

  it('a leave for someone we never saw → nothing changes, no negative counts', () => {
    const presence = apply(joined('bob', 'Bob'));
    expect(applyPresenceMessage(presence, left('stranger'), ME)).toBe(presence);
  });

  it('our own join is not listed as another dispatcher', () => {
    expect(apply(joined(ME, 'Me'))).toEqual({});
  });
});

describe('Presence — who is viewing which truck', () => {
  it('viewing updates the truck; switching trucks moves the viewer', () => {
    const presence = apply(joined('bob', 'Bob'), viewing('bob', 'truck_3'), viewing('bob', 'truck_5'));
    expect(viewersOf(presence, 'truck_5').map((d) => d.id)).toEqual(['bob']);
    expect(viewersOf(presence, 'truck_3')).toEqual([]);
  });

  it('viewing from someone who joined before we connected → shown online (count 1) so their leave removes them', () => {
    const presence = apply(viewing('early', 'truck_1'));
    expect(presence['early']).toEqual({ id: 'early', name: null, connections: 1, viewingTruckId: 'truck_1' });
    expect(apply(viewing('early', 'truck_1'), left('early'))).toEqual({});
  });

  it('viewing from an unregistered socket (null id) or from ourselves is ignored', () => {
    expect(apply(viewing(null, 'truck_1'), viewing(ME, 'truck_1'))).toEqual({});
  });

  it('a leave clears what they were viewing', () => {
    const presence = apply(joined('bob', 'Bob'), viewing('bob', 'truck_3'), left('bob'));
    expect(viewersOf(presence, 'truck_3')).toEqual([]);
  });
});

describe('Presence — names', () => {
  it('names are remembered after a dispatcher leaves (for history labels)', () => {
    let names: Readonly<Record<string, string>> = {};
    names = rememberName(names, joined('bob', 'Bob'));
    names = rememberName(names, left('bob'));
    expect(names).toEqual({ bob: 'Bob' });
  });
});
