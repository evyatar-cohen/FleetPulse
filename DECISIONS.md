# Decisions Log

Running log of technical decisions: what we chose, what we rejected, why, and the trade-off.
Feeds the README and interview prep.

---

## Phase 0 — Explore

### D1. `server.js` restored from the PDF page images
- **Decision:** The copy-paste from the PDF corrupted operators (`===` → `=`, `||` → `|`, `&&` → `&`).
  We fixed only these copy errors so the file matches the PDF exactly. No logic changes.
- **Alternatives:** use the pasted text as is; find the original HTML source of the assignment.
- **Why:** the pasted version was broken (e.g. `req.method = 'OPTIONS'` made every request return an empty 200).
  The original source file was not available.
- **Trade-off:** a manual restore can contain a typo we didn't notice. Mitigated by running the server and
  checking every endpoint and quirk against the captured fixtures.

### D2. Test fixtures captured from the real server by a script
- **Decision:** `scripts/capture-fixtures.mjs` connects to SSE, WebSocket and REST, triggers the quirks,
  and saves real payloads to `fixtures/{sse,ws,rest}/`.
- **Alternatives:** copy messages by hand from DevTools; write synthetic fixtures by hand.
- **Why:** rare quirks (fuel 0, ghost leave) need minutes of waiting. A script is repeatable and documents
  how the data was produced.
- **Trade-off:** values are random on every run, so tests must assert on structure and behavior, not exact numbers.

### D3. Capture script uses only Node built-ins
- **Decision:** global `fetch` and `WebSocket` (Node 22+), SSE parsed by hand from the raw stream.
- **Alternatives:** `ws` / `eventsource` npm packages.
- **Why:** no extra dependencies for a dev tool; parsing raw `data:` frames shows exactly what the server sends.
- **Trade-off:** requires Node 22+.

### Findings from real data (input for later phases)
- **Speed 999:** truck_7 is in `maintenance` (real speed 0). Stuck episodes can chain with only one real reading
  between them (`999 999 0 999 999`). "Physically impossible value" is a stronger signal than "repeated value".
- **Fuel glitch:** `73.6 → 0 → 0 → 73.5`. A 0 can't be classified when it arrives — it needs a "suspicious, wait"
  state, with a time limit after which a persistent 0 is treated as real.
- **GPS batch:** 12 readings spanning 22 s, all older than the latest live reading; positions jittered ±0.001°.
  Arrives right before the same tick's normal telemetry.
- **Out-of-order:** a reading 7.8 s old (older than ~3 previous readings) — compare to the last *accepted*
  timestamp per truck, not to the previous reading.
- **409 bodies differ:** the immediate one has `lastModifiedBy`; the delayed one only `currentVersion`.
  "Who" comes from the WS `route_updated` / `route_reassigned` event with the matching `route._version`,
  fallback `GET /api/routes`.
- **Ghost leave race confirmed:** reconnect with the same id at +1.0 s, stale `dispatcher_left` at +10.0 s while
  the dispatcher is online. Timestamps can't detect it (the stale leave is newer). Direction: count joins/leaves
  per id; ignore leaves for our own id. Final design in Phase 6.
- **Unregistered sockets receive broadcasts** — connecting before registering means we miss less.
- **No "list online dispatchers" message** — a new tab only learns about dispatchers who join or act after it.
- **`/api/telemetry/history` returns random data**, not real history.
- **`npm install express` gives Express 5**; the server was likely written for Express 4
  (in Express 5, a request without a JSON body makes `req.body` undefined → 500). Decide pinning in Phase 1.
