# AI Usage Journal

How I used AI (Claude Code) in this project: what I asked, what it produced, and what I questioned,
changed or rejected.

**Setup:** before starting, I wrote a `CLAUDE.md` with the project context, my background (backend engineer,
new to JS/TS/React), the working rules (one phase at a time, plan before code, explain after code, no
unapproved libraries) and the target architecture. The goal: use AI as a pair programmer I can learn from,
and never submit code I can't explain.

---

## Phase 0 — Explore

**What I asked**
- Read `CLAUDE.md` and the full assignment PDF (including the mock server code), summarize my situation and
  the plan, and ask what is unclear — no code yet.
- Create a `server.js` file for me to paste the server code into, then run it and check it works.
- Explain how to watch the server's messages myself.
- Capture real payloads as test fixtures.

**What the AI produced**
- A summary plus questions. It found a server gap I hadn't noticed: a new dispatcher never receives the list of
  dispatchers already online, and a ghost `dispatcher_left` can arrive after the same id reconnected.
- After my paste, it found that copying from the PDF had corrupted the code (`===` → `=`, `||` → `|`), which made
  the server unusable (every request returned an empty 200). With my approval it restored the file from the PDF
  page images and smoke-tested REST, SSE and WebSocket.
- Instructions for watching SSE (browser / `curl -N`) and WebSocket (DevTools console + Network → WS).
- `scripts/capture-fixtures.mjs` and 35 fixture files covering every quirk, plus a list of findings from the
  real data (see DECISIONS.md).

**What I questioned / changed / rejected**
- The AI said it would show me the diff of the restored `server.js` before running it, but it rewrote and ran
  the file without showing the diff. It admitted this afterwards; I verified the changed lines myself.
- It noticed `npm install` brings Express 5 while the server was likely written for Express 4 — left open
  for Phase 1.
- End-of-phase check: I answered the fuel-glitch question correctly (wait for next readings). I didn't know how
  to find *who* caused the delayed 409, or how to detect a stale ghost leave — the AI explained (match the WS
  event by route version; count joins/leaves per dispatcher id). We deferred the final ghost design to Phase 6.

**My notes**
- _(add your own notes here)_

---

## Phase 1 — Skeleton & types

**What I asked**
- A skeleton with `src/{transport,domain,store,ui}` and `tests/`, React + Vite, `npm start` running server and
  client together, `npm test` passing, and core types.
- Before approving Zod I asked whether it is really best practice.
- A GLOSSARY.md of key terms, and an INTERVIEW_PREP.md cheat sheet with every check question and its model answer.

**What the AI produced**
- A plan with 6 design choices and rejected alternatives, which I approved before any code was written.
- An honest comparison for Zod: why runtime validation is needed, alternatives (Valibot, ArkType, hand-written
  guards), and its costs (bundle size, policy for unknown fields and invalid messages).
- `package.json`, `tsconfig.json` (strict), Vite config with a dev proxy, React entry, domain schemas
  (`models.ts`, `events.ts`, `api.ts`), and 37 tests validating every Phase 0 fixture against the schemas plus
  negative cases.

**What the AI caught / changed along the way**
- `"type": "module"` would have broken `server.js` (CommonJS) — kept it out.
- Pinned `express@4` because of the Express 5 `req.body` difference found in Phase 0.
- Vite warned about ESM syntax in a CommonJS-loaded config → renamed it to `vite.config.mts`.
- Rewrote a dense test helper it had first written (nested ternary + type cast) into a plain function, to match
  the project's readability rules.
- Flagged a trade-off for my decision: strict enums for route status drop events with unknown values.

**What I questioned / changed / rejected**
- Asked whether Zod is best practice before accepting it.
- End-of-phase check: Q1 (why Zod as well as TS) partly right; Q2 correct; Q3 (discriminated unions) I asked for an
  explanation. Answers recorded in INTERVIEW_PREP.md.

**My notes**
- _(add your own notes here)_

---

## Phase 2 — Telemetry pipeline

**How I worked with the AI this phase**
- Asked for a short checklist and one item at a time, after the AI's first plan message was too long.
- Required TDD: for each step, the AI writes tests first, I approve them, then it writes the logic.
- Before each implementation I asked the AI to explain the problem and list edge cases.

**What the AI produced**
- Pure functions in `src/domain/telemetry/`: ordering by timestamp, GPS batch handling, bounded path,
  a sensor detector registry (speed, fuel) and vehicle profiles — 95 tests in total, using the Phase 0 fixtures.

**What I questioned / changed / rejected**
- **Test organization:** asked for tests organized by feature. The AI went too far (an index README); I rejected
  it and kept only a short header comment in each test file.
- **Future timestamps:** the AI suggested only documenting the "far-future timestamp" edge case; I chose to code it.
  When I asked if 60 s was safe in the real world and said not to over-engineer, the AI replaced its
  browser-clock + offset idea with a simpler one: compare against the server's own event timestamp.
- **Path size:** I challenged "keep the last N points" ("don't we lose the whole path?"). We compared a recent tail,
  thinning, and keep-all; I chose the tail (300 points ≈ 10 min) and asked to document that a real system keeps
  full history in a backend DB.
- **Speed limit:** I asked what happens at 220 km/h for a few seconds. That led to per-vehicle-type limits
  (vehicle profiles) instead of one global number.
- **Maintainability:** I asked for adding features and vehicle types to be easy → two registries
  (vehicle profiles, sensor detectors). I asked where the vehicle type would come from, since the server doesn't
  send one → it comes from the backend's fleet data; default `truck` for now.
- **Fuel:** the AI's first rule only checked drops. I asked about an impossible *rise* (15 → 80) → the rule became
  symmetric and time-based. I asked "what did we miss?" → 4 more scenarios (out-of-range values, values that keep
  jumping, drift during the check, alerts using only trusted values). I asked for the full scenario list before tests.
- **Code review before merge:** I asked for a review of the branch. It found 5 real bugs in the fuel detector
  (e.g. a held glitch accepted as real after 4 s, low-fuel 8 → 0 not caught) and 3 cleanups. The AI verified each
  by hand, wrote failing tests first (5 failed on the old code), then fixed them: measure the rate from the previous
  reading, cap the gap, lower the rate to 1.5 pts/s, keep the episode start across statuses.
- I asked why the window is 6 s and where the "4 s" came from → server.js QUIRK 2 (2–4 s) + one reading interval;
  in the real world it would be tuned from logged glitch durations.

**My notes**
- _(add your own notes here)_

---

## Phase 3 — Transport

**How I worked with the AI this phase**
- Asked for a remaining-phases estimate; pushed back that 18–26 h was too much → we agreed a faster mode
  (tests + code together for simple items, tests-first only for tricky logic), estimate ~10–14 h.
- For each item: asked to understand what it means, how it will be implemented, and the options/trade-offs —
  choice by choice, with alternatives.

**What I questioned / changed**
- Asked for SSE vs WebSocket differences, and what optimistic locking and `If-Match` mean ("explain like I'm
  stupid"); clarified that `_version` is the data field and `If-Match` the header we send.
- Asked what a dispatcher can do after a conflict → keep theirs / apply mine / cancel, never auto-retry.
- Challenged "no retry for writes" ("as a user I'd want to retry") → automatic retry for reads only, manual Retry
  for writes, detect "my own earlier attempt succeeded".
- Asked whether the server really sends Retry-After → yes for its 503, but we fall back to backoff without it.
- Noticed the circuit breaker is a **bonus** feature and asked to finish main tasks before bonuses; decided to
  finish the breaker anyway since it's already started (and is listed in the grading).
- Asked what really happens with a passive breaker → step-by-step timeline.
- Chose heartbeat-based dead-connection detection for SSE (20 s) over the AI's 10 s telemetry-based recommendation.
- Asked whether the dispatcher is alerted when the stream is down → connection badge + banner (Phase 4) and
  counters for observability.
- Declined a temporary "live connection" demo page; kept the original plan.
- **Review loop:** asked the AI to spawn a reviewer subagent and iterate until both agree. Round 1: 4 findings
  (a real circuit-breaker bug — past `retryAtMs` during a probe — plus 3 test gaps), all verified and fixed with
  tests. Round 2: 1 new MEDIUM (a proxy's HTML 503 was treated as invalid data → no retry/breaker), fixed with
  tests. Round 3: approved. (The first reviewer run was lost when the session restarted; it was re-launched.)

**My notes**
- _(add your own notes here)_
