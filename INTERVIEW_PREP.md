# Interview Prep — Cheat Sheet

Questions from the end-of-phase checks, with model answers. Each answer has a **one-liner** (what to say first)
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
**One-liner:** The marker doesn't move (all readings are older than the current one); their positions are inserted
into the path in timestamp order.

**Detail:**
- A batch goes through the same `ingestReading()` as single readings — one code path.
- Each reading is classified: older than current → `stale` → path only; newer → `accepted` → marker + path.
- The path stays sorted, skips duplicate timestamps, and is capped at 300 points (~10 min) so memory stays fixed.
- Limitation: the server jitters batch positions, so the path can zig-zag.

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
