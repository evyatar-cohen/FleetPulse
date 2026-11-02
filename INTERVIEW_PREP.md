# Interview Prep — Cheat Sheet

Questions from the end-of-phase checks, with model answers (always the CORRECT answer, updated when the code changes). Each answer has a **one-liner** (what to say first)
and **detail** (if they dig deeper). "My answer" notes where I was wrong or incomplete — those are the ones to review.

---

## Phase 0 — Explore

### Q1. A reading has `fuel: 0`. Do we show a low-fuel alert immediately?
**One-liner:** No — a single 0 can't be classified when it arrives; we mark it "suspicious" and wait for the next
readings, with a time limit.

**Detail:**
- The server's fuel sensor glitches to 0 for 2–4 s and then recovers (`73.6 → 0 → 0 → 73.5`).
- While waiting, the UI shows the last good value marked as "checking".
- The wait must be **bounded**: if fuel is still 0 after ~6 s, it's real → alert. Otherwise a real empty tank is
  never reported.
- Detection is generic (sudden drop + recovery within a window), not hardcoded to the server's numbers.

*My answer: "wait for next readings to confirm glitch" — correct; missing the time limit.*

### Q2. The delayed 409 doesn't say who changed the route. Where do we get "who"?
**One-liner:** From the WebSocket — every successful change is broadcast with its author; we match the event whose
`route._version` equals the 409's `currentVersion`.

**Detail:**
- `route_updated` carries `updatedBy`; `route_reassigned` carries `reassignedBy`.
- The client keeps the latest WS event per route; on a 409 with `currentVersion: N`, it looks up the event with
  `route._version === N`.
- The WS event usually arrives before the 409, but they travel on **different connections** — order isn't
  guaranteed. If it's not there yet: wait briefly or refetch.
- Fallback: `GET /api/routes` → `lastModifiedBy` (PATCH) or `reassignedBy` (reassign).
- Backend analogy: DB version conflict → read the audit log for who wrote that version.

*My answer: not sure.*

### Q3. A `dispatcher_left` arrives for Carol while she is connected again. How do we know it's stale?
**One-liner:** Timestamps can't tell (the stale leave is *newer*); instead count connections per dispatcher id —
offline only when the count reaches 0.

**Detail:**
- The server sends exactly one `joined` and one `left` per socket. Join → +1, leave → −1.
- Sequence: join (1) → close (ghost, leave delayed 10 s) → rejoin (2) → stale leave (1, still online) →
  real leave (0, offline).
- Like reference counting.
- Weak spots: if our tab opened after Carol's first join, we never counted it → the count can hit 0 early
  (self-heals on her next event). We may also receive a ghost leave about **ourselves** after reconnecting
  with the same id → ignore leaves for our own id.
- Final design: Phase 6.

*My answer: not sure.*

---

## Phase 1 — Skeleton & types

### Q4. TypeScript already has types. Why do we also need Zod?
**One-liner:** TS checks my code; Zod checks the data I don't control.

**Detail:**
- TS types are erased at runtime (like Python type hints). `JSON.parse()` returns `any`, so TS can't know what the
  server actually sent.
- A bad payload (e.g. `speed: "999"`) would pass silently and crash deep in the UI.
- Zod validates at the trust boundary (transport) — "parse, don't validate". After that, the types are true.
- The TS type is derived from the schema (`z.infer`), so the two never drift apart. Python analogy: pydantic.

*My answer: "Zod is for declaration and validation of objects" — partly right; missing why TS alone isn't enough
(types erased at runtime).*

### Q5. Why Zod schemas for incoming WS messages but plain TS types for outgoing ones?
**One-liner:** Validation belongs where untrusted data comes in; outgoing messages are built by our own code, and
the compiler already checks them.

*My answer: correct.*

### Q6. What does checking `msg.type === 'route_updated'` give us in a discriminated union?
**One-liner:** Narrowing — inside that branch TS knows the exact message shape, so only its fields are accessible,
and it can warn when a new message type isn't handled.

**Detail:**
- `WsServerMessage` = one of 11 shapes, each with a fixed literal `type`.
- Before the check, `msg.updatedBy` is a compile error (most shapes don't have it). After it, it's allowed.
- Benefits: safe field access, exhaustiveness checks in `switch`, accurate autocomplete.
- Python analogy: `match` over a `Union` of pydantic models with `Literal` type fields — but here enforced on every
  type check, not optional like mypy.

*My answer: asked for an explanation.*

---

## Phase 2 — Telemetry pipeline

### Q7. A GPS batch of 20 old readings arrives. What happens to the marker and the path?
**One-liner:** The marker doesn't move — a batch is history (readings buffered while the truck had no signal); its
positions are added to the path only where physically plausible. The live telemetry in the same tick keeps the marker
current.

**Detail:**
- `ingestBatch()` never moves the marker or touches sensors. Exception: a truck with no position yet takes the
  batch's newest reading as its first position.
- Why not let a "newer" batch reading move it: the batch's newest timestamp can be a few ms newer than the last live
  reading, but its position is random jitter (±~100 m) — it would jump the dot to a fake spot (found by a real-data
  test, D38).
- Path: a batch point is inserted (sorted by timestamp, no duplicate timestamps) only if reaching it from its
  time-neighbors needs ≤ the vehicle's max speed; capped at 300 points (~10 min) so memory stays fixed.

*My answer: correct.*

### Q8. Fuel jumps from 73% to 0%. What does the dispatcher see now and over the next 6 s?
**One-liner:** Right away: the last trusted value (73%) marked "checking". If it comes back near 73% → it was a
glitch; if it stays off for 6 s → we accept and show the new value as real.

**Detail:**
- The rule is generic: fuel can't change faster than 1.5 points/second, up or down (from the vehicle profile),
  measured from the previous reading — so the allowance doesn't grow while a glitch lasts.
- Why 6 s: the longest known glitch (4 s, server.js QUIRK 2) + one reading interval (2 s) to see it end.
  Real world: tune it from logged glitch durations.
- While `unverified`, no low-fuel alert can fire — alerts use only the trusted value.
- The 6 s window is the safety bound: a real problem is never hidden for longer.
- Each episode ends with `resolved: 'glitch' | 'confirmed'`, which the anomaly dashboard can log.
- Out of 0..100 → `sensor_fault` immediately, no window.

*My answer: mostly right — but after 6 s we don't "flag abnormal behavior": we accept the value as real and show it.*

### Q9. How do we add a new vehicle type, "van"?
**One-liner:** Add one entry to `VEHICLE_PROFILES`, and have the backend send `vehicleType: 'van'` in the fleet data —
no other code changes.

**Detail:**
- Every detector reads its limits from the profile, so nothing else needs editing.
- Until the backend sends the type, the schema defaults it to `truck`; an unknown type falls back to the default
  profile instead of crashing.

*My answer: correct.*

---

## Phase 3 — Transport

### Q10. SSE vs WebSocket — what's the difference and why use both?
**One-liner:** SSE is one-way (server → client) over plain HTTP with built-in reconnect; WebSocket is two-way. We use
SSE for telemetry (we only receive) and WebSocket for presence and route events (we also send).

**Detail:**
- SSE: a long HTTP response of `data: …` lines; the browser's `EventSource` reconnects by itself; keep-alive =
  server heartbeat (15 s here).
- WebSocket: its own protocol after an HTTP upgrade; reconnect is manual; keep-alive = our `ping` → `pong`.
- We send `register_dispatcher`, `ping`, `viewing_truck` → needs WS.

### Q11. What is optimistic locking and how does `If-Match` work here?
**One-liner:** Don't block editors; detect conflicts when saving. We send the route's `_version` in `If-Match`; if the
server's version differs, it rejects with 409 instead of overwriting.

**Detail:**
- `_version` is a field in the route data (set by the server, +1 on each change); `If-Match` is the request header
  we send with that value. Like `UPDATE … WHERE version = 3` in a DB.
- Without it: last write wins silently — the assignment's "nobody knew who did what" story.
- This server: `If-Match` is optional (we must always send it); reassign has no version check (only client-side
  warnings + detection via WS — a real fix needs the server); a 409 can arrive late without "who".

### Q12. A 409 happened. What does the dispatcher see and do?
**One-liner:** Who changed it and what changed, then: keep theirs (default), apply mine anyway (resend with the new
version, after confirmation), or cancel. Never retry automatically.

**Detail:**
- An automatic retry with the new version = last write wins = the bug the lock prevents.
- If the other change made mine impossible (route completed/cancelled), only "OK" is offered.
- "Who": from the 409 body (immediate one) or the WS event with the matching `route._version` (delayed one).

### Q13. Why does the REST client return results instead of throwing?
**One-liner:** Because a 409 or 503 is normal flow here, not an exception — returning
`{ ok: false, error: { kind } }` makes the compiler force every caller to handle it.

**Detail:** alternatives were exceptions (TS doesn't track thrown types, easy to forget), `null` (loses why),
a library (new dependency), a hybrid (two mechanisms). `fetch` itself doesn't throw on 4xx/5xx — only on "no answer"
(like Python `requests` without `raise_for_status()`).

### Q14. Why not retry writes automatically?
**One-liner:** They aren't idempotent — after a timeout we don't know if the server already saved it, so a retry could
create a route or send an alert twice.

**Detail:** reads are retried automatically (503, network, timeout; Retry-After or backoff; max 3 attempts; wait cap
10 s). Writes get a manual "Retry" button; if the retry gets a 409 caused by our own id, the first attempt succeeded.
PATCH with `If-Match` is naturally safe (a repeat gets 409).

### Q15. How does the circuit breaker work, and what does the dispatcher see?
**One-liner:** After 3 failed requests in a row it stops calling the server for 10 s, shows the last data as "stale",
then lets one probe through; success closes it again.

**Detail:**
- States: CLOSED → (3 failures) → OPEN → (cooldown over) → HALF-OPEN → probe ok → CLOSED / probe fails → OPEN.
- It's passive — a gatekeeper checked on each call, like a decorator/middleware, not a background service.
- It sits inside retry, so it counts every request and an open breaker answers instantly (`circuit_open`).
- Dispatcher: a few seconds of retries, then a "stale since …" banner; the map keeps moving (SSE is separate);
  the banner disappears by itself on recovery. Server: one request per 10 s while sick.
- It's a bonus feature in the brief, but listed under "Performance & Resilience" in the grading.

### Q16. How do you know the live stream is dead, and what happens then?
**One-liner:** A watchdog: any message (heartbeat every 15 s, telemetry every 2 s) resets a 20 s timer; if it fires,
we close the connection and reconnect with backoff 1 s → 2 s → … → 30 s, forever, and the UI shows "live data lost
since …".

**Detail:**
- `EventSource` reconnects by itself after a short drop, but gives up for good on an error status (CLOSED) and
  can't notice a silent "open but dead" connection — the two gaps we fill.
- A hanging attempt (never opens) is caught by the same watchdog. Backoff resets after a successful open.
- Why heartbeat-based (20 s) and not 10 s from the telemetry rhythm: the heartbeat is the server's explicit
  liveness signal, so no false alarms if telemetry slows. Cost: up to ~20 s frozen → "last update N s ago" in UI.
- No replay (server sends no event ids): positions recover next tick, path keeps a gap, fleet snapshot reloaded.
- Invalid messages are dropped and counted, never thrown. Real product: reconnect counts → monitoring.

### Q17. Walk me through the WebSocket lifecycle. What happens on a reconnect?
**One-liner:** Open → `register_dispatcher` (with the id saved in sessionStorage) → `registered` → ping every 10 s;
if the socket closes, misses a pong (5 s) or never registers (10 s) → reconnect with backoff, re-register with the
SAME id, and re-send the truck we're viewing.

**Detail:**
- Same id after reconnect/reload = the same dispatcher for others (not a new person). sessionStorage = per tab,
  so two tabs are two dispatchers (needed for conflict testing); localStorage would merge them.
- Ping/pong because the WS is often silent for minutes — a passive watchdog can't tell "quiet" from "dead".
  The round trip doubles as latency for observability.
- No outgoing queue: presence is state, so only the latest viewed truck is re-sent (a queue would replay stale
  "viewing 3, 5, 7").
- Unregistered sockets still receive broadcasts on this server (Phase 0 finding), but we treat the client as
  ready only after `registered`, because REST writes need the id.
- Ghost `dispatcher_left` about ourselves after a reconnect → handled in the presence logic (Phase 6).

### Q18. `/api/fleet` returned 503 three times in a row. What does the dispatcher see, and what does the server get?
**One-liner:** A "stale since …" banner over the last fleet data while the map keeps moving (SSE is separate); the
breaker sends nothing for 10 s, then one probe — so at most one fleet request per 10 s until a probe succeeds.

**Detail:** the 3 failures can come from one retried call (the breaker sits inside retry and counts each request).
While open, calls fail instantly inside the app (`circuit_open`). Probe ok → closed, banner gone; probe fails →
open for another 10 s. Don't confuse with SSE reconnect backoff (1 s → 30 s cap) — a different mechanism.

*My answer: mixed it up with the SSE reconnect ("one request every 30 s forever").*

### Q19. Why ping/pong on the WebSocket but only watch the heartbeat on SSE?
**One-liner:** Because of who sends the keep-alive: the SSE server sends a heartbeat every 15 s by itself, so we can
wait passively; the WS server sends nothing on its own and the channel can be quiet for minutes, so we must ask.

**Detail:** WS being two-way is what *allows* a ping; the *need* is the missing server heartbeat. Ping every 10 s,
no pong in 5 s → dead → reconnect. The round trip doubles as latency for observability.

*My answer: "WS is two-directional so it needs ping/pong" — close, but the key reason is the missing server heartbeat.*

### Q20. A create-route request times out and the dispatcher clicks Retry. What can go wrong and how is it handled?
**One-liner:** The first request may have succeeded (only the answer was lost), so a retry could duplicate it. We never
retry writes automatically; on a manual retry, a 409 "truck already assigned" whose `assignedBy` is OUR id means the
first attempt worked → show success.

**Detail:**
- True idempotency needs server support (e.g. an `Idempotency-Key` header) — this server has none, so the client
  can only detect, not prevent.
- PATCH with `If-Match` is naturally safe (a repeat gets 409 because the version moved).
- Send alert has no protection → could be sent twice: documented limitation; real fix = idempotency key on server.

*My answer: "make it idempotent and ignore the repeat" — right risk, but we can't make the server idempotent; we
detect "it was me" from the 409 instead.*

---

## Phase 4 — Minimal UI

### Q21. Where does the business logic live — in the store or elsewhere? Why?
**One-liner:** In pure domain functions; store actions are thin — read state, call the domain function, save the
result. Like a backend's thin handler → service function → DB.

**Detail:**
- Example: `applyTelemetry(event)` → `applyTelemetryEvent(trucks, event)` (pure, runs the Phase 2 pipeline) → `set`.
- Tests stay "data in → data out" with no store, React or mocks; swapping Zustand changes ~2 lines per action.
- Zustand chosen over React Context because components subscribe to only the slice they read (selectors) —
  with 12 trucks every 2 s, Context would redraw every consumer on every change.
- Unchanged input returns the same object → React sees "no change" → no redraw.

### Q22. Walk me through what happens when the page opens.
**One-liner:** WS connect → `register_dispatcher` → `registered` gives our id (set on the REST client) → load the fleet
(retry + breaker) → open SSE; then a fleet refresh every 30 s.

**Detail:**
- Why WS first: REST writes need `X-Dispatcher-Id`, which only `registered` gives us.
- The REST snapshot gives every truck a first position before the first SSE tick (and if SSE is down).
- Reload the fleet on: every `registered` (a WS gap may have hidden events), `fleet_reset`, SSE back from
  reconnecting (no replay). While the breaker is open, the next load is the probe at the cooldown end.
- All wiring is in one function, `startApp()` (composition root), with injected fetch/EventSource/WebSocket →
  tested with fakes; `stop()` cleans up (needed for React StrictMode and tests).

### Q23. How do you keep the UI from freezing with 12 trucks every 2 s plus 30-reading bursts?
**One-liner:** The store updates on every event (data exact), but components read live truck data through a hook
that redraws at most once per second — the first change immediately, a burst collapsed into one trailing redraw.

**Detail:**
- Throttling the *drawing*, not the *data*: alerts/conflicts still see current data; nothing is lost.
- Plus: Zustand selectors (only components using a slice redraw), unchanged input returns the same object (no
  redraw), bounded data (300-point paths).
- The throttle is a pure timing helper tested with fake timers; the hook is thin glue (subscribe in `useEffect`,
  unsubscribe + cancel in its cleanup).
- Trade-off: up to 1 s display lag — invisible with 2 s telemetry.

### Q24. The map path looked like a scribble near some trucks. What was it and how did you fix it?
**One-liner:** GPS batch points are random jitter around the current position with old timestamps; drawn in time order
they zig-zag impossibly. A late point now joins the path only if it's reachable at ≤ the vehicle's max speed, and a
batch is treated as history — it never moves the marker.

**Detail:**
- Same generic rule as the speed detector ("physically impossible"), using the vehicle profile's max speed.
- A real-data test caught a subtle case: the batch's newest reading can be a few ms NEWER than the last live
  reading, so it was accepted and moved the marker. Fix: batch = history; only a truck with no position yet takes
  the batch's newest reading as current.
- The current (live) position is always added — a long gap can legitimately make a big jump.

### Q25. Telemetry every 2 s for 12 trucks + 30-reading bursts — what stops the UI from redrawing all the time?
**One-liner:** Throttled rendering: the store updates on every event, but live-data components read it through a hook
that redraws at most once per second (first change at once, a burst collapsed into one trailing redraw).
Trade-off: up to 1 s display lag.

**Detail:** plus Zustand selectors (only components using a slice redraw) and returning the same object when nothing
changed (no redraw at all). Don't confuse with the path plausibility filter — that decides *which positions are
drawn*, not *how often* the screen is redrawn.

*My answer: described the path plausibility filter (a different feature).*

### Q26. The fleet endpoint is failing and the breaker is open. When does the app try again, and what does the dispatcher see?
**One-liner:** The next fleet load is scheduled for the end of the 10 s cooldown (that call is the single probe), not
the normal 30 s; meanwhile a "Fleet data is stale since HH:MM:SS" banner shows the last known data, and the map keeps
moving because SSE is a separate channel.

**Detail:** probe ok → breaker closed, banner gone, back to the 30 s refresh; probe fails → open for another 10 s.
The connection badges stay "● Live" — the WebSocket and SSE are fine; only the REST fleet snapshot is stale.

*My answer: not sure.*

### Q27. Why is `startApp()` one function outside React instead of code inside components?
**One-liner:** One composition root keeps the startup order readable in one place, is testable without React (fake
fetch/EventSource/WebSocket), and its `stop()` makes React StrictMode's dev double-start safe.

**Detail:** components only show data and call actions; they don't create connections. If each component started
what it needs, the order (WS → registered → fleet → SSE) would be scattered and things could start twice.

*My answer: "to run things in order" — right, but only one of the three reasons.*
