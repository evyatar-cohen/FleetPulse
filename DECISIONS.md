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
  (in Express 5, a request without a JSON body makes `req.body` undefined → 500). Decided in Phase 1: pin `express@4`.

---

## Phase 1 — Skeleton & types

### D4. Zod schemas are the single source of truth for payload types
- **Decision:** every server payload has a Zod schema; its TS type is derived with `z.infer`.
- **Alternatives:** plain TS types + hand-written type guards; Valibot (same idea, smaller bundle).
- **Why:** TS types are erased at runtime and can't check server data. One definition gives both the runtime
  validator and the type, so they can't drift. Native support for discriminated unions.
- **Trade-off:** ~10–15 KB gzipped bundle; small parse cost per message (negligible at ~13 messages / 2 s).

### D5. Payload schemas live in `domain/`, not `transport/`
- **Decision:** `src/domain/{models,events,api}.ts`. Transport *uses* them to parse incoming data.
- **Alternatives:** keep wire schemas inside transport.
- **Why:** they are pure (no I/O) and shared by the whole app (domain logic, store, UI all use the types).
- **Trade-off:** domain types mirror the server's wire format; if the server format diverged from what the UI
  needs, we'd add a mapping layer then.

### D6. Strict enums for route status and priority
- **Decision:** `status` ∈ assigned / in-progress / completed / cancelled; `priority` ∈ low / normal / high.
- **Alternatives:** accept any string, validate only what we send.
- **Why:** the server accepts any value; an unknown value means something we don't understand — reject rather
  than display it wrong.
- **Trade-off:** an event with an unknown value is dropped → that route's state goes stale. Revisit in Phase 5.

### D7. No `"type": "module"` in package.json; Vite config as `vite.config.mts`
- **Decision:** the package stays CommonJS by default; the Vite config uses `.mts` to be treated as ESM.
- **Alternatives:** `"type": "module"` for the whole package.
- **Why:** `server.js` uses `require` (CommonJS) and must not be modified — `"type": "module"` would break it.
- **Trade-off:** one unusual file extension.

### D8. Vite dev proxy for `/api` and `/ws`
- **Decision:** the client uses relative URLs; Vite forwards them to `localhost:3000`.
- **Alternatives:** hardcode `http://localhost:3000` in the client (works — the server sends CORS `*`).
- **Why:** the server address lives in one place; no cross-origin requests.
- **Trade-off:** works in dev only; a production build would need a real reverse proxy (out of scope).

### D9. Pin `express@4`
- **Why:** matches the server's era; avoids the Express 5 `req.body` difference found in Phase 0.

### D10. Typecheck is a separate script
- **Decision:** `npm run typecheck` (`tsc --noEmit`); `npm test` runs Vitest only.
- **Why:** Vitest strips types without checking them; `tsc` is the real type checker.
- **Trade-off:** two commands to run before committing.

---

## Phase 2 — Telemetry pipeline

### D11. Order readings by timestamp; reject readings from the future
- **Decision:** a reading becomes the truck's current state only if its timestamp is newer than the current one
  (equal = duplicate, older = stale). A reading later than `now + 60 s` is rejected as a clock bug, where `now` is
  the server send time of the event that carried it (`event.timestamp`).
- **Alternatives:** trust arrival order; compare against the browser clock; no future guard.
- **Why:** QUIRK #5 sends older readings late. Using the server's own timestamp avoids browser-clock differences.
  The guard stops one bad timestamp from freezing a truck forever.
- **Trade-off / limitation:** a truck whose clock is always > 60 s ahead looks frozen (all readings rejected).
  In a real system the backend should fix or flag device clocks.

### D12. A GPS batch goes through the same function as single readings
- **Decision:** `ingestBatch()` loops over `ingestReading()`. Late readings (stale or batch) fill the path but
  never move the marker; accepted readings do both.
- **Alternatives:** separate batch logic; drop old readings entirely.
- **Why:** one code path = fewer bugs; old positions still show where the truck was.
- **Limitation:** the server jitters batch positions randomly (±0.001°), so the path can zig-zag.

### D13. The map path is a bounded tail: last 300 points per truck (~10 min)
- **Decision:** `MAX_PATH_POINTS = 300`; when full, the oldest point is dropped.
- **Alternatives:** thin older points to keep the whole trip at lower detail; keep everything.
- **Why:** the live map answers "where is the truck and where is it going". Memory stays fixed
  (~3,600 points ≈ 250 KB for 12 trucks) so the app can run for hours.
- **Real-world note:** the full trip history belongs in a backend database; the UI would fetch it on demand.
  Not possible here — the mock server's `/api/telemetry/history` returns random data.

### D14. Vehicle profiles registry
- **Decision:** every physical limit lives in `VEHICLE_PROFILES[vehicleType]` (`src/domain/vehicles.ts`).
  Adding a vehicle type = one entry. The type comes from the server's fleet data (`vehicleType`, default `truck`);
  an unknown type falls back to the default profile.
- **Alternatives:** one global limit; `if (type === …)` branches in detectors.
- **Why:** the same reading can be valid for one type and impossible for another (220 km/h: car yes, truck no).
  Answers the grading question "add a vehicle type without touching existing code".
- **Real-world note:** the type comes from the backend's vehicle DB inside the fleet payload, loaded once —
  the frontend never queries a DB per reading.

### D15. Sensor detector registry
- **Decision:** each sensor check is a module with the same shape (`id`, `evaluate(previous, reading, profile)`);
  `SENSOR_DETECTORS` lists them; the pipeline loops over the list. Detectors run only on accepted readings.
- **Alternatives:** hardcoded checks inside the pipeline; class inheritance.
- **Why:** adding a check = one file + one list entry, no pipeline change (proved by adding fuel after speed).
- **Speed rule:** outside `0..profile.maxSpeedKmh` → show the last valid speed (or unknown) + `sensor_fault`.
  Rejected "repeated identical value" — idle trucks really do report 0 repeatedly.

### D16. Fuel: symmetric rate-of-change rule + confirmation window
- **Decision:** a change faster than `maxFuelChangePerSecond` (1.5 pts/s), up or down, measured from the
  **previous reading** (gap capped at 4 s), is `unverified` → show the last trusted value. Back near it → `glitch`;
  still off 6 s after the jump started → accepted as real (`confirmed`). Outside 0..100 → `sensor_fault`. The episode
  start is kept across `unverified` ↔ `sensor_fault`.
- **Alternatives:** `fuel === 0` check; drop-only check; allowance measured from the last trusted reading.
- **Why:** generic (not tied to this server's 0), catches impossible rises too (the 15% → 80% story in the brief),
  never hides a real change for more than 6 s. Measuring from the previous reading keeps the allowance from
  growing during a glitch; the gap cap means a big change after a pause/reconnect waits for the window.
- **Review fixes (code review before merge):** the first version measured from the last trusted reading with
  5 pts/s, so a held glitch was accepted early (15 → 0 accepted at 4 s), low-fuel drops (8 → 0) passed, any glitch
  after a long gap passed, and an out-of-range reading reset the window. All covered by new tests.
- **Trade-off / limitation:** a real sudden change is shown up to 6 s late. Below ~3% a drop to 0 fits the
  allowance and isn't caught. If the stream stops while unverified, the value stays "checking" — the
  connection-status indicator (Phase 3) covers it. The low-fuel alert must use only the trusted value (later phase).

---

## Phase 3 — Transport

### D17. REST client returns `Result` values, not exceptions
- **Decision:** every method returns `{ ok: true, data } | { ok: false, error }`; `error.kind` is a discriminated
  union (version_conflict, truck_assigned, unavailable, network, timeout, invalid_response, …).
- **Alternatives:** throw exceptions; return null; a Result library (neverthrow); hybrid (results + throws).
- **Why:** a 409 is normal flow in this app (two dispatchers clash). The type forces callers to handle it, and the
  error carries what the UI needs (who, current version).
- **Trade-off:** an `if (!result.ok)` at every call site.

### D18. `RestClient` is a class with `fetch` injected; built-in fetch + 10 s timeout
- **Decision:** `new RestClient({ fetch })`; `setDispatcherId()` after WS `registered`. Writes before that are refused
  locally (`not_registered`). `If-Match` on every route update. Path ids are URL-encoded.
- **Alternatives:** global functions + global id; factory with closure; patching global fetch in tests (or MSW);
  axios / ky.
- **Why:** visible state, same pattern as SSE/WS clients; tests run the real code with a fake fetch; no dependency
  for a thin wrapper; we write the resilience logic ourselves because it's graded and must be explained.
- **Trade-off:** ~30 lines of our own error handling; one extra constructor parameter.

### D19. Retry and circuit breaker are wrappers outside the client; business rules live in `domain/`
- **Decision:** `withRetry` and `CircuitBreaker` wrap calls explicitly. Automatic retry only for reads (idempotent).
  Writes get a manual "Retry" in the UI; a 409 from our own earlier attempt is treated as success.
- **Alternatives:** retry inside every client method; a resilience library (cockatiel/opossum).
- **Why:** each piece is simple and tested alone; a write can never be retried by accident (a lost response could
  otherwise create a route twice or send an alert twice).
- **Trade-off:** one more layer; nested-looking calls.

### D20. Retry policy for reads
- **Decision:** `withRetry()` retries temporary errors (503, network, timeout); 3 attempts in total; wait =
  `Retry-After` (seconds) when present, otherwise exponential backoff (1 s, 2 s); a requested wait above 10 s →
  return the error immediately. `sleep` is injected so tests don't wait.
- **Alternatives:** retry only 503; fixed wait; retry forever / 5+ attempts; always obey Retry-After.
- **Why:** respects the server's hint (assignment requirement) but works without it (network errors, proxies,
  HTTP-date format). 3 attempts make a failed load ~0.3% likely at 15% 503s; the cap keeps the UI responsive —
  long outages are the circuit breaker's job.
- **Not done:** jitter (random spread of waits) — matters with many clients ("thundering herd"), not with 1–2 tabs.

### D21. Circuit breaker on `GET /api/fleet` (bonus, partly graded under Performance & Resilience)
- **Decision:** a passive state machine CLOSED → OPEN → HALF-OPEN. Failures = 503, network, timeout (same list as
  retry). It counts **every request**: it sits inside retry — `withRetry(() => breaker.call(() => rest.getFleet()))`.
  3 failures in a row → OPEN for a 10 s cooldown: calls return `circuit_open` immediately (retry doesn't retry it).
  After the cooldown the next call is the probe (HALF-OPEN): success → CLOSED, failure → OPEN again.
  While open, the store shows the last fleet data marked "stale"; SSE positions keep updating.
- **Alternatives:** count only 503 (a dead server would never trip it); breaker outside retry (needs 9 failed
  requests to trip); active breaker with its own probe timer; growing cooldown.
- **Why:** matches the spec ("503 three times consecutively"), reacts fast, and protects a sick server (one request
  per 10 s instead of a stream). Passive = no timers or lifecycle in the breaker; the clock is injected for tests.
  The store's 30 s fleet refresh (Phase 4) provides the calls and schedules the next one at the cooldown end.
- **Trade-off:** recovery is noticed only on the next call (≤ ~10 s with scheduling).
