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
