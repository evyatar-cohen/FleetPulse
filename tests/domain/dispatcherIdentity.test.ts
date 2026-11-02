// Feature: Names for dispatchers we never saw join (late-joining tab)
// Tests:   src/domain/dispatcherIdentity.ts → makeDispatcherId(), nameFromDispatcherId()
// Rule:    our ids look like dispatcher_<random>.<base64url name>; any client can read the name back. Ids in any other
//          format (made by the server) or with a broken/too-long name give null → the UI shows the id instead.
import { describe, expect, it } from 'vitest';
import { makeDispatcherId, nameFromDispatcherId } from '../../src/domain/dispatcherIdentity';

describe('Dispatcher id with the name inside', () => {
  it('round trip: the name comes back from the id, including non-Latin names and symbols', () => {
    for (const name of ['Alice', 'Zoë Smith', 'דנה', 'A+B/C?=']) {
      expect(nameFromDispatcherId(makeDispatcherId(name, 'a1b2c3d4'))).toBe(name);
    }
  });

  it('the id is plain header-safe ASCII (it is sent as X-Dispatcher-Id)', () => {
    expect(makeDispatcherId('דנה / Zoë', 'a1b2c3d4')).toMatch(/^dispatcher_a1b2c3d4\.[A-Za-z0-9_-]+$/);
  });

  it('same name in two tabs → two different ids (the random part)', () => {
    expect(makeDispatcherId('Alice', 'aaaa1111')).not.toBe(makeDispatcherId('Alice', 'bbbb2222'));
  });

  it('server-made ids and broken encodings have no name', () => {
    expect(nameFromDispatcherId('dispatcher_1a2b3c4d')).toBeNull();
    expect(nameFromDispatcherId('dispatcher_x.!!!')).toBeNull();
    expect(nameFromDispatcherId('dispatcher_x.')).toBeNull();
    expect(nameFromDispatcherId('other_x.QWxpY2U')).toBeNull();
  });

  it('a name longer than our 40-character limit is not trusted', () => {
    expect(nameFromDispatcherId(makeDispatcherId('x'.repeat(41), 'a1b2c3d4'))).toBeNull();
  });
});
