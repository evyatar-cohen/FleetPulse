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

### D22. SSE client uses the browser's `EventSource` (+ our own watchdog and reconnect-after-give-up)
- **Decision:** `EventSource` for `/api/telemetry/stream`; we add what it lacks (see D23+).
- **Alternatives:** `fetch` + parse the `data:` frames ourselves (full control, ~40 more lines to own and test).
- **Why:** built-in parsing and auto-reconnect; the SSE endpoint needs no custom headers.
- **Trade-off:** we don't control its own retry timing (~3 s, browser-defined), and it stops for good on an error
  status (CLOSED) — we reconnect ourselves in that case.

### D23. Dead SSE connection detected by heartbeat timeout
- **Decision:** a watchdog resets on every message (heartbeat, telemetry, batch); if nothing arrives for 20 s
  (heartbeat interval 15 s + margin) the connection is treated as dead → close, mark `reconnecting`, reopen.
- **Alternatives:** a 10 s timeout based on the 2 s telemetry rhythm (faster, but tied to telemetry frequency);
  no detection.
- **Why:** the heartbeat is the server's explicit liveness signal, independent of how often telemetry is sent —
  no false alarms if telemetry slows down.
- **Trade-off:** up to ~20 s of frozen positions before we react. Mitigation (Phase 4): show "last update N s ago".

### D24. SSE reconnect: exponential backoff 1 s → 30 s cap, never give up
- **Decision:** when `EventSource` gives up (CLOSED) or the watchdog declares it dead, we open a new one after
  1 s, 2 s, 4 s … capped at 30 s; reset to 1 s after a successful connection. A hanging attempt is caught by the
  same 20 s watchdog. Status changes are reported (`onStatusChange`) → UI connection badge + "live data lost
  since …" banner (Phase 4). Reconnect attempts and dropped messages are counted (observability).
- **Alternatives:** fixed delay (hammers a dead server); give up after N attempts + manual retry button.
- **Why:** a wall-screen dashboard must heal by itself; at most one attempt per 30 s is harmless to the server.
- **Real-world note:** reconnect counts would also go to monitoring (Sentry/metrics) — out of scope here.

### D25. No replay after an SSE gap; fleet snapshot reloaded on reconnect
- **Decision:** the server sends no event ids, so missed telemetry can't be replayed. Positions recover on the next
  tick; the map path keeps an honest gap; the store reloads the REST fleet snapshot after a reconnect (Phase 4).
  `EventSource` is injected (like `fetch`) so tests drive a fake; timers use Vitest fake timers.
- **Alternatives:** interpolate missing path points (invents data); `Last-Event-ID` resume (server doesn't support it).
- **Trade-off:** a gap in the path after an outage.

### D26. WebSocket client on the browser's built-in `WebSocket`
- **Decision:** native `WebSocket` (injected, faked in tests) + our own reconnect, ping/pong and re-registration.
  Backoff calculation shared with the SSE client (one helper). Dispatcher id kept in `sessionStorage`
  (decided at kickoff: one dispatcher per tab, survives reload).
- **Alternatives:** `reconnecting-websocket` (reconnect only — not our registration/ping/re-send logic);
  `socket.io-client` (needs a socket.io server — incompatible with the plain `ws` server).
- **Why:** no dependency; same pattern as SSE; the important logic is ours anyway.

### D27. WebSocket keep-alive: ping every 10 s, no pong within 5 s → dead
- **Decision:** while open, send `ping` every 10 s; if no `pong` arrives within 5 s → close and reconnect.
  Each ping→pong round trip is recorded as latency (observability).
- **Alternatives:** a message watchdog like SSE (the WS is often silent for minutes → false alarms or a very long
  timeout); no keep-alive (a dead socket silently stops route events → missed conflicts).
- **Why:** an active check works on a quiet channel; detects a dead socket within ~15 s.
- **Trade-off:** a tiny message every 10 s.

### D28. Outgoing WS messages: no queue — re-send current state after reconnect
- **Decision:** `register_dispatcher` is sent on every connect (with the saved id). For `viewing_truck` we keep only
  the latest truck viewed and send it once after (re)registering. Nothing is queued.
- **Alternatives:** queue all messages while offline (sends stale "viewing 3, 5, 7" → cursor jumps for others);
  drop and never re-send (others don't see what we view after a reconnect).
- **Why:** presence is state, not history — only the latest value matters.
- **Trade-off:** a future outgoing message type needs its own "re-send on reconnect" rule.
- **Also:** if `registered` doesn't arrive within 10 s of opening, the attempt counts as failed → reconnect.

### D29. Shared connection helpers
- **Decision:** `src/transport/connection.ts` holds what SSE and WS share: `ConnectionStatus`, `backoffDelay()`
  (1 s → 30 s cap) and `parseMessage()` (JSON + Zod; invalid → null, dropped and counted by the caller).
- **Why:** one implementation of the backoff and of "untrusted message → typed or dropped"; found as a duplicate
  while writing the WS client and extracted.

### D30. Review-loop fixes (Phase 3, reviewer subagent, 3 rounds until approved)
- **Circuit breaker:** a call refused while the half-open probe runs now gets `retryAtMs = now + cooldown`. Before,
  it got the already-past cooldown end → a caller scheduling its next attempt by it would spin.
- **REST client:** a non-JSON body is `invalid_response` only for 2xx. For an error status the status decides the
  kind — a proxy's HTML 503 page is still `unavailable`, so retry and the breaker work. A non-JSON 409 degrades to
  `invalid_response` (no retry, no breaker trip, no crash).
- **Tests added:** `circuit_open` is never retried; connect → close → connect for SSE and WS; one misleading
  test name fixed.

---

## Phase 4 — Minimal UI

### D31. Map = simple SVG coordinate grid, not Leaflet
- **Decision:** draw trucks (markers), their recent path and status colors in an SVG scaled to the fleet's lat/lng
  bounds. No map library.
- **Alternatives:** Leaflet + react-leaflet (real street map; 2 dependencies; tiles need internet).
- **Why:** the assignment says "map quality is not graded … a simple coordinate grid … is fine. We're testing your
  data pipeline". No dependency, works offline, fully meets the requirement (12 live trucks, status distinction,
  one marker per truck + path for batches).
- **Trade-off:** no streets/landmarks; a bonus like geofencing would draw zones on the same grid.

### D32. State store: Zustand
- **Decision:** one Zustand store holds trucks, routes, connection status and freshness.
- **Alternatives:** React Context + useReducer (every consumer re-renders on every change — bad at 12 trucks × 2 s);
  Redux Toolkit (more boilerplate and concepts); our own store + `useSyncExternalStore` (re-implementing Zustand).
- **Why:** tiny (~1 KB), components subscribe only to the slice they read (selectors), usable outside React
  (transport callbacks write to it directly).
- **Trade-off:** a new dependency.

### D33. Store actions are thin; logic lives in pure domain functions
- **Decision:** a store action only reads state, calls a pure domain function (e.g.
  `applyTelemetryEvent(trucks, event)` → new trucks) and saves the result. No logic inside the store.
- **Alternatives:** write the logic inside Zustand actions.
- **Why:** same as a backend's thin handler → service function → DB. Domain functions are tested like Phase 2
  (data in → data out, no store, no React, no mocks); swapping the store library would change ~2 lines per action.
- **Trade-off:** one more small file per area.

### D34. Fleet state = REST info + Phase 2 telemetry per truck
- **Decision:** `TruckView` = info from `GET /api/fleet` (name, vehicle type, route, snapshot status) + Phase 2
  `TruckTelemetry`. The snapshot is also fed in as a first reading (timestamp = response time) through the normal
  ordering rules — trucks have a position before the first SSE tick, and an older snapshot never overwrites newer
  live data. Live status = newest accepted reading. Trucks missing from a new snapshot are removed; a reading for an
  unknown truck creates it. Unchanged input returns the same object (no redraw).
- **Alternatives:** wait for SSE before showing trucks (empty map if SSE is down); keep REST and SSE data separate.
- **Trade-off:** each 30 s snapshot adds one extra path point per truck.

### D35. Startup wiring in one place: `src/app/startup.ts`
- **Decision:** `startApp()` creates the REST/SSE/WS clients, wires their callbacks to the store and runs the
  startup order (WS → registered → fleet → SSE), the 30 s fleet refresh and `fleet_reset` handling; `stop()`
  cleans everything. React calls it once. Dependencies (fetch, EventSource, WebSocket, id store) are injected →
  tested with fakes. `src/app/` is the "composition root": the one place that knows every layer.
- **Alternatives:** start connections from inside React components.
- **Why:** the order is readable in one function; no double-start under React StrictMode; testable without React.
- **D35 addendum — details:** the next fleet load is scheduled at the breaker cooldown end while open (that call is
  the probe), otherwise in 30 s. Reloads also on every `registered` (initial + after a WS gap), on `fleet_reset`,
  and when SSE returns from `reconnecting`. A load requested while one is in flight is skipped.
  **Limitation:** a `fleet_reset` arriving during an in-flight load is covered only by the next refresh (≤ 30 s).

### D36. Throttled rendering: the UI reads a 1 s throttled view of the store
- **Decision:** the store updates on every SSE event (data exact, nothing lost); components that show live truck
  data read it through a hook that re-renders at most once per second (first change immediately, last change
  always delivered). The throttle is a small pure-timing helper tested with fake timers; the hook is thin glue.
- **Alternatives:** batch store writes every second (delays data for everyone, complicates the pipeline);
  no throttling (graded requirement; batch bursts could freeze the UI — the "froze last Tuesday" story).
- **Trade-off:** the display can lag up to 1 s behind the data.

### D37. Dashboard UI pieces
- **Name form** (not `window.prompt`): trimmed, 1–40 chars, saved in sessionStorage with the dispatcher id.
- **Header:** SSE ("Telemetry") and WS ("Dispatch") badges; "fleet data stale since …" banner while the fleet can't
  be loaded (breaker/degraded mode); "live telemetry interrupted" banner only while SSE is reconnecting (not during
  the normal first connect).
- **Truck list:** trusted speed/fuel + flag (`⚠ sensor fault`, `⏳ checking`), "—" when no trusted value; "updated N s
  ago" keeps counting via a 1 s clock hook. Limitation: the age compares server timestamps with the browser clock
  (equal on one machine; off by the skew otherwise).
- **Map:** SVG, auto-fit to all known positions (north up), dot = current position, line = recent path.
- **Error boundaries** around header, map and list: one crashing panel shows a message + "Try again"; the rest keeps
  working. Errors are logged to the console (real product: monitoring).
- **Untested by unit tests:** React components themselves (no DOM test library added — would need new dependencies);
  their logic is in tested pure helpers (format, projection, throttle, selectors).

### D38. Path plausibility filter + GPS batch treated as history (supersedes part of D12)
- **Problem (seen in the browser):** batch positions are random jitter (±~100 m) around the CURRENT position with
  old timestamps → sorted by time they draw an impossible zig-zag "scribble". Also, the batch's newest reading can be
  a few ms newer than the last live reading → it was "accepted" and moved the marker to a noisy position.
- **Decision:** (1) a late point joins the path only if reaching it from its time-neighbors needs ≤ the vehicle's
  `maxSpeedKmh` (`isPlausiblePathPoint`, flat-earth distance, min 1 ms). (2) A GPS batch is history: it never moves
  the marker or touches sensors; it only fills the path (plausible points only). Exception: a truck with no position
  yet takes the batch's newest reading as current. Live telemetry keeps the normal ordering rules; the current
  (accepted) position is always added — the marker is the truth.
- **Alternatives:** keep drawing every point (honest but misleading); drop batches entirely; smooth the path.
- **Why:** the same "physically impossible" rule as the speed detector — generic, not batch-specific; found by a
  real-data test that failed on the first version (the few-ms-newer batch reading).
- **Trade-off:** a genuinely fast real movement between two late points would be hidden from the path (never the marker).

---

## Phase 5 — Routes

### D39. Routes live in the same store; WS route events applied by version
- **Decision:** `routes` is a new part of the single Zustand store; logic in pure `domain/routes.ts`. Sources:
  `GET /api/routes` at startup and the WS events `route_assigned` / `route_updated` / `route_reassigned` (the server
  broadcasts them to everyone, including the dispatcher who made the change). An event is applied only if its
  `route._version` is newer than what we have (old/duplicate events never overwrite newer data). The same action
  updates the trucks' `currentRouteId` (assign → set; complete/cancel → clear; reassign → move). `fleet_reset`
  clears routes too.
- **Alternatives:** a separate routes store (a reassign touches routes and trucks → two stores could briefly disagree).
- **Why:** one action updates everything a route event affects, atomically.

### D40. Client-side audit log, seeded from the routes snapshot
- **Decision:** the server has no audit endpoint, so we build the log from WS route events (who, what, when, route
  version), keeping the last 200 entries. At startup it is seeded from `GET /api/routes`: each route's
  `assignedBy/At`, `reassignedBy/At`, `lastModifiedBy/At` become entries marked "from snapshot". Entries are keyed by
  route + kind + the server's timestamp of that change, so a reloaded snapshot or a live event describing the same
  change never creates a duplicate.
- **Alternatives:** start empty at page load (simpler; a dispatcher opening the page sees no history).
- **Why:** the dispatcher sees the existing history right away (user's choice).
- **Limitation:** from the snapshot we only know the LATEST change of each kind per route (and not the previous
  value) — intermediate changes before the tab opened are lost. A real system would have a server-side audit log.

### D41. Route business rules enforced on the client (the server accepts anything)
- **Decision:** pure `domain/routeRules.ts`, used by the UI (disable invalid buttons) and by the actions (check again
  before sending). Status transitions: assigned → in-progress | cancelled; in-progress → completed | cancelled;
  completed / cancelled are final (assigned → completed blocked: a route can't finish without starting). New route:
  destination 3–200 chars (trimmed), priority low/normal/high (default normal), notes ≤ 500 chars, the truck must
  exist, have no current route and not be in maintenance. Reassign: route not finished, target ≠ current truck,
  target exists, has no route, not in maintenance.
- **Alternatives:** rely on the server (it accepts any status/destination; it even creates a route on a maintenance
  truck and marks it active).
- **Why:** the brief asks for input validation; blocking "create on maintenance" is consistent with the server's own
  reassign rule.
- **Real-world note:** the backend must enforce these too — client checks are for UX, not security.

### D42. Describing a 409: who and what, from the most reliable source
- **Decision:** pure `describeConflict()`. "Who/what" priority: (1) our audit-log entry for the route with
  `version === currentVersion` (the exact change that beat us); (2) our stored route if already at `currentVersion`
  (newest of `lastModifiedBy` / `reassignedBy`); (3) the 409 body's `lastModifiedBy`. If none → "needs refresh": the app
  reloads routes ONCE and describes again; still unknown → "changed by another dispatcher". If the change was made by
  our own id and the route already has what we wanted → "already applied" (our earlier attempt succeeded). Options:
  keep theirs / apply mine (only if the transition is still allowed from the CURRENT status) / cancel.
- **Why the body comes last:** server.js answers `lastModifiedBy: route.lastModifiedBy || route.assignedBy` — after a
  reassign (which doesn't set lastModifiedBy) the immediate 409 names the route's CREATOR, not who changed it. The
  delayed 409 has no "who" at all (QUIRK #8).
- **Alternatives:** trust the 409 body; poll until the WS event arrives.

### D43. Route actions: pessimistic ("saving…"), one request, no automatic retry
- **Decision:** `src/app/routeActions.ts` (create / update status / apply-mine-after-conflict / reassign). Each checks
  the client rules first (nothing sent if invalid), sends ONE request (≤ 10 s timeout) while the UI shows "saving…",
  and returns an outcome: success, already applied, conflict (described by D42 — reloading routes once inside the
  saving phase if "who" is unknown), truck taken (POST 409, with `byMe`), invalid, or error (network/timeout →
  retryable via a manual Retry button). The screen updates from the WS event (sent by the server just before the
  HTTP answer), so the action doesn't write the route itself — that also keeps the audit log complete.
- **Alternatives:** optimistic update + rollback (a PATCH can 409 up to 1 s later → the status would jump back).
- **Why:** never show unconfirmed data; one source of truth (server → WS → store).
- **Trade-off:** 0.2–1 s "saving…" per action (the server's artificial delay).
- **D43 addendum:** if the route already has the wanted status (e.g. a manual Retry after a timeout whose first attempt
  worked), the action returns "already applied" without sending. The 409-based detection (D42) covers the case where
  the store hasn't seen that change yet (409 → reload routes → our id + our values → already applied).

### D44. Reassign race (no server lock): check before sending, detect after
- **Decision:** (1) the reassign dialog remembers the route version when opened; before sending, if the version moved,
  the action returns "changed since opened" (who + what from the audit log) and the dispatcher must confirm again.
  (2) After a successful reassign, another dispatcher's `route_reassigned` for the same route within ±5 s of ours is
  shown as "X also reassigned this route at the same time — it's now on truck Y". Pure functions over the audit log.
- **Alternatives:** nothing (silent last-write-wins — the brief's "nobody knew who did what" story); polling.
- **Why:** `PUT /reassign` has no version check, so the client can only narrow the window and make clashes visible.
- **Limitation (interview point):** this doesn't PREVENT a clash; the real fix is an `If-Match` check on the server.
  The 5 s window is a trade-off (shorter misses slow clashes, longer flags unrelated reassigns).

### D45. Confirmations only on critical route actions
- **Decision:** a confirmation dialog before Cancel route, Complete route and Reassign; not before Start route.
- **Why:** the brief asks for "confirmation on critical actions"; cancel/complete are final and reassign moves work
  between drivers (and has no server lock). Start is routine and easy to correct — confirming it would train
  dispatchers to click "OK" without reading.

### D46. Routes UI
- **Decision:** routes panel (allowed next actions only, per-route "⏳ saving…", inline outcome messages), new-route
  form (unavailable trucks shown greyed out with the reason), confirm dialog for complete/cancel, reassign dialog
  (itself the confirmation: an explicit "Reassign to <truck>" button; remembers the version it opened with), conflict
  dialog (who + what + now vs. yours; Keep theirs / Apply mine), audit log panel (newest first, "from snapshot"
  marked). Route components read trucks through the 1 s throttled hook — they only need names/route ids, so telemetry
  must not redraw them every 2 s. `startApp` returns the route actions; App passes them down as props.
- **Alternatives:** `window.confirm` (blocking, unstyled, no context); React Context for actions (one consumer — not
  worth it yet).
- **Limitation:** until Phase 6, other dispatchers are shown by id ("You" for ourselves) — names need presence data.

### D47. "Already done by them" instead of a conflict when both wanted the same change
- **Found by:** the two-tab browser test — both dispatchers pressed "Start"; the loser's dialog said "your change was
  NOT applied" although the route was exactly as they wanted.
- **Decision:** if the route at the conflicting version already has our wanted values (made by someone else),
  `describeConflict` sets `sameAsMine` (no "apply mine"); the UI shows "Already done — <who> <what> just before you"
  with a single OK.

### D48. One-screen dashboard layout
- **Decision:** header on top, then a full-height CSS grid: map (top-left) + trucks (bottom-left) | routes (middle) |
  route history (right). Each area scrolls on its own; the map SVG shrinks to fit its area. Below 1100 px wide the
  areas stack and the page scrolls.
- **Why:** user request — a dispatcher should see the fleet, the routes and the history at the same time without
  scrolling the page.

### D49. Low-fuel alert on the TRUSTED fuel value only
- **Decision:** `isLowFuel()` = trusted fuel (`sensors.fuel.value`) < `profile.lowFuelPercent` (15% for trucks). Shown
  as a red "⛽ low fuel" flag in the truck list (it outranks "checking"/"sensor fault").
- **Why:** the brief's "don't trigger false low-fuel alerts" assumes there are low-fuel alerts. Using the trusted value:
  a glitch to 0% never alerts (trusted value stays at the last good level); a real low level stays alerted through a
  glitch; an unverified sudden "rise" keeps the alert until confirmed (safe direction); a real 0% that holds is
  alerted after the 6 s window. Threshold per vehicle type (tank size).
- **Verification:** the mock server's real fuel takes hours to get low and never goes below 5% — the behavior is
  verified with tests driven through the real fuel detector (incl. the captured glitch sequence), not in the browser.

---

## Phase 6 + 7 — Presence and vehicle detail panel

### D50. Presence by counting connections per dispatcher id (QUIRK #6 ghost)
- **Decision:** pure `domain/presence.ts`. `dispatcher_joined` → connections + 1; `dispatcher_left` → − 1; online while
  > 0. Leaves about ourselves are ignored; a leave for an unknown id changes nothing (no negative counts);
  `dispatcher_viewing` from an unknown id adds them with 1 connection (they joined before us). Names are remembered
  after a dispatcher leaves (routes/history still mention them).
- **Alternatives:** compare timestamps (fails: the ghost leave is NEWER than the rejoin); ignore leaves for 10 s after a
  join (a magic number tied to this server's delay).
- **Why:** the server sends exactly one joined and one left per socket, so counting is exact — like reference counting.
- **Limitation (fixed by D53):** the server never sends a list of who's online, so at first someone who joined BEFORE
  us was invisible until they acted. D53 makes everyone announce themselves when a newcomer joins.
- **Remaining edge:** if someone online before us reconnects (joined → 1) and their ghost leave of the OLD socket
  arrives (→ 0), they briefly disappear until their next announce/action (we never counted their old connection).
  Real fix: a "who's online" snapshot from the server.

### D51. One "select truck" action drives the detail panel AND presence
- **Decision:** clicking a truck (list row or map marker) calls `RunningApp.selectTruck`: stores `selectedTruckId`
  (opens the detail drawer) and sends `viewing_truck` over the WS. Other dispatchers see "👁 <name>" on that truck and
  in its detail panel. Deselecting (closing the panel) sends `viewing_truck` with an empty truckId ("not viewing",
  see D53), so the viewer tag disappears for the others.
- **Why:** one user intent, one place that performs both effects; components don't talk to the WS directly.

### D52. Detail panel: trusted-value charts, mileage on demand, alerts
- **Charts:** each accepted reading appends a sample of TRUSTED values (speed/fuel from the detectors, raw engine
  temperature) to a per-truck history capped at 150 samples (~5 min) — so charts never show 999 km/h or a glitch 0%.
  Drawn as small SVG sparklines (no chart library); a missing trusted value breaks the line instead of inventing data;
  fuel uses a fixed 0–100 scale.
- **Mileage:** only in `GET /api/fleet/:id` → loaded when the panel opens and every 30 s while open (a read → retried);
  answers arriving after the panel switched truck are ignored.
- **Alerts:** message 3–200 chars (trimmed), severity info/warning/critical; critical needs confirmation. ONE request
  (POST is not idempotent — a lost answer must not send the alert twice). Alerts arrive back via the WS `truck_alert`
  broadcast (kept, bounded to 50, de-duplicated by id) and are listed in the truck's panel.
- **Alternatives:** a chart library (recharts — new dependency for 3 sparklines); polling mileage for all trucks.


### D53. Late joiners see who's already online: everyone announces on `dispatcher_joined`
- **Problem (found in the browser):** a tab opened later showed only itself. The server sends `dispatcher_joined` only
  to the OTHER clients and has no "who's online" message, so a newcomer never hears about earlier dispatchers.
- **Decision:** when we receive `dispatcher_joined` for someone else, we re-send our `viewing_truck` (`WsClient.announcePresence()`).
  The server forwards it to everyone as `dispatcher_viewing`, and the newcomer adds us (D50: an unknown viewer counts
  as 1 connection). Not viewing a truck → we send an empty truckId, which `domain/presence.ts` reads as
  "online, viewingTruckId null". The same empty value is sent when the detail panel closes (D51).
- **Alternatives:** poll/refetch a list (no such endpoint); send `register_dispatcher` again (would broadcast a second
  `dispatcher_joined` and break connection counting); a new message type (server ignores unknown types).
- **Trade-off:** `dispatcher_viewing` has no name → earlier dispatchers were shown by id (fixed by D54). With N dispatchers, each join causes N−1 small messages — fine at dispatcher-team scale. Uses a
  convention (empty truckId) that only our client understands; an older client would show "viewing ''" (no such truck,
  so no tag appears).

### D54. The dispatcher's name travels inside their id
- **Problem (found in the browser):** a later tab showed earlier dispatchers by id — in presence AND in conflicts,
  the audit log and route lists. The only message with a name is `dispatcher_joined`, sent only to clients already
  connected; route events, 409 bodies and `dispatcher_viewing` carry ids only.
- **Decision:** we choose our own id at first register (the server accepts any `dispatcherId`):
  `dispatcher_<8 random hex>.<name as base64url>`. Pure `domain/dispatcherIdentity.ts` encodes/decodes it;
  `dispatcherLabel()` (used by every screen) tries: name from `dispatcher_joined` → name decoded from the id → the id.
  The id is kept in sessionStorage as before (same identity after a reload); a saved id that doesn't carry the
  current name is replaced.
- **Alternatives:** shared localStorage id → name map (only works for tabs in the same browser — hides the problem
  in our test setup, fails for real dispatchers on other machines); encode the name in `viewing_truck`'s truckId
  (abuses a field with another meaning, only fixes presence, not conflicts/audit log); keep ids (D53 limitation).
- **Why:** one small pure module fixes names everywhere, for anyone whose id we ever see — even dispatchers who left
  before we opened the app. No server change.
- **Trade-off:** longer ids; the name is fixed at registration (a new name → a new identity); the name is
  client-provided — the same trust as the server's own `name` field. Decoded names are treated as untrusted input:
  invalid base64/UTF-8 or > 40 characters → ignored (show the id); React escapes them when rendering. Ids made by
  another client/server (no `.`) just show the id.
- **Real-world fix:** names come from login (user table / auth token) and the server sends a presence snapshot to
  new clients (in Redis when there are several server instances); clients never invent identities.

## Phase 8 — Bonuses

### D55. Observability panel reads the transport counters directly, not through the store
- **Decision:** a "🛠 Dev" button (bottom-left) opens a small panel: SSE messages/s (10 s average), SSE and WS
  received / dropped, reconnect counts, WS ping → pong latency. It reads `SseClient.stats` / `WsClient.stats` (counters
  the clients already kept since Phase 3) once per second, **only while open**.
- **Alternatives:** put the stats in the Zustand store (every second → store update → every subscribed screen
  re-checks; dev numbers would cost dispatcher screens); a 1-second delta for the rate (the server sends bursts every
  2 s, so it jumps 0 ↔ ~24).
- **Why:** developer-facing data shouldn't touch the dispatcher data path; polling only when open costs nothing
  otherwise. "Dropped" = failed JSON/Zod validation at the transport boundary.
- **Trade-off:** counters are since page load (not per minute); the rate starts empty for a second after opening.
  Not shown: retry counts and circuit-breaker state (the stale banner already shows degraded mode).

### D56. Filterable fleet view: one filter for list and map; regions = quadrants around the city center
- **Decision:** four dropdowns above the truck list — status, fuel (low / under 50%), region, route (has / no route) —
  plus Clear. Filters combine with AND. Pure `ui/truckFilter.ts`. The list hides non-matching trucks ("5 of 12");
  the map **dims** them (removing them would rescale the map and move every other dot). Filter state is local to
  `App` (per tab), not in the store.
- **Fuel** uses the TRUSTED value (same as the low-fuel alert), so a glitch 0% never makes a truck "low"; "low" uses
  the vehicle profile threshold (15% for trucks).
- **Regions:** the server has none, so `domain/regions.ts` defines four quadrants (NE/NW/SE/SW) around the server's
  `CITY_CENTER` (Tel Aviv) — copied, because no API exposes it.
- **Unknown values don't match:** a truck with no reading yet / no trusted fuel isn't shown under a fuel/region
  filter — we show only what we can confirm.
- **Alternatives:** free-drawn regions on the map (that's the geofencing bonus — much bigger); filter in the store
  (no other screen needs it); hide filtered trucks on the map too (map jumps).
- **Trade-off:** the quadrant regions are arbitrary and the center is a copied constant; a real system would get
  named regions (depots, districts) from the backend.

