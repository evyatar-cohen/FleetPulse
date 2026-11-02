// Dispatcher ids that carry the dispatcher's name, so ANY client can show a name for ANY id it sees.
// Data flow: startup.ts creates our id (makeDispatcherId) before the first register_dispatcher; the UI's
// dispatcherLabel() falls back to nameFromDispatcherId() for ids it never saw a dispatcher_joined for.
//
// Why: the only server message with a name is dispatcher_joined, and it goes only to clients that are ALREADY
// connected. Route events, 409 bodies and dispatcher_viewing carry ids only. So a tab opened later could never learn
// the names of earlier dispatchers. The server accepts any dispatcherId we register with, so we put the name inside.
// Format: dispatcher_<random>.<name as base64url> — base64url is plain ASCII, safe in the X-Dispatcher-Id header.
// Ids made by the server (dispatcher_1a2b3c4d, no dot) simply have no name → callers fall back to the id.
// Pure functions: no I/O, no store, no React.

const PREFIX = 'dispatcher_';
const SEPARATOR = '.';
// Same limit as the name form. A longer decoded name didn't come from our client → not trusted.
const MAX_NAME_LENGTH = 40;

// `randomPart`: makes the id unique (two tabs with the same name are two dispatchers). Must not contain '.'.
export function makeDispatcherId(name: string, randomPart: string): string {
  return `${PREFIX}${randomPart}${SEPARATOR}${toBase64Url(name)}`;
}

// The name inside an id made by makeDispatcherId(); null for any other id or an invalid encoding.
export function nameFromDispatcherId(dispatcherId: string): string | null {
  const separatorIndex = dispatcherId.indexOf(SEPARATOR);
  if (!dispatcherId.startsWith(PREFIX) || separatorIndex === -1) return null;
  let name: string;
  try {
    name = fromBase64Url(dispatcherId.slice(separatorIndex + 1));
  } catch {
    // Not valid base64 or not valid UTF-8 — someone else's id format.
    return null;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

// UTF-8 first, so names like "Zoë" or "דנה" work (btoa alone only accepts Latin-1 characters).
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  // Put back the '=' padding we stripped (base64 length must be a multiple of 4).
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // fatal: invalid UTF-8 throws instead of producing garbage characters.
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
