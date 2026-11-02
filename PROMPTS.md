# AI Usage Journal

How I built this project together with an AI assistant (Claude Code): what I asked for, what it produced, and where
I steered it — questions it hadn't considered, suggestions I rejected, and mistakes I caught.

**Setup.** Before starting, I wrote a `CLAUDE.md` with the project context, my background (backend engineer, new to
JS/TS/React), the working rules (one phase at a time, plan before code, explain after code, no unapproved
libraries) and the target architecture. The goal: use AI as a pair programmer I can learn from, and never submit
code I can't explain. Every decision went into [DECISIONS.md](DECISIONS.md) with its alternatives and trade-offs.

**How the way of working changed.**
- Phases 0–2: small steps, one item per message, tests written first and approved by me before any logic.
- Phase 3: I pushed back on a long time estimate → "faster mode": tests and code together for simple items,
  tests-first only for tricky logic (circuit breaker, 409 conflicts, ghost presence).
- From Phase 5: the AI works autonomously and surfaces only important or architecture decisions; it writes every
  decision and trade-off down so nothing gets lost. Review subagents only when it is genuinely unsure (cost/time).

### Highlights — where I steered the AI

- **Presence bug it had accepted as a limitation.** In the browser, a second tab didn't see the first dispatcher.
  The AI had documented this as "the server never sends an online list". I didn't accept that → clients now announce
  themselves when someone joins (D53).
- **"Why an id and not a name?"** I questioned why the new tab showed ids, asked how this works in real systems,
  and why a conflict message did show a name. That revealed the same gap in conflicts and the audit log → names now
  travel inside the dispatcher id (D54).
- **Fuel rule.** The AI's first rule only checked drops. I asked about an impossible *rise* (15% → 80%) → a
  symmetric, time-based rule; then "what did we miss?" → 4 more scenarios.
- **Retries for writes.** I challenged "no retry for writes" ("as a user I'd want to retry") → manual Retry plus
  detection of "my earlier attempt already went through".
- **Speed limit.** "What happens at 220 km/h?" → per-vehicle-type limits instead of one global number.
- **Map path.** I spotted a "scribble" on the map → a physical-plausibility filter, which exposed a real bug.
- **Code reviews.** I asked for reviews before merging; they found 5 real bugs in the fuel detector and a
  circuit-breaker bug, each fixed with a failing test first.
- **Scope.** I kept required work ahead of bonuses, and chose which bonuses to build.

---

## Phase 0 — Explore

**What I asked**
- Read `CLAUDE.md` and the full assignment PDF (including the mock server code), summarize my situation and the
  plan, and ask what is unclear — no code yet.
- Create a `server.js` for me to paste the server code into, then run it and check it works.
- Explain how to watch the server's messages myself; capture real payloads as test fixtures.

**What the AI produced**
- A summary plus questions. It found a server gap I hadn't noticed: a new dispatcher never receives the list of
  dispatchers already online, and a ghost `dispatcher_left` can arrive after the same id reconnected.
- After my paste, it found that copying from the PDF had corrupted the code (`===` → `=`, `||` → `|`), which made
  the server unusable (every request returned an empty 200). With my approval it restored the file from the PDF
  page images and smoke-tested REST, SSE and WebSocket.
- Instructions for watching SSE (`curl -N`, browser) and WebSocket (DevTools).
- `scripts/capture-fixtures.mjs` and 35 fixture files covering every quirk.

**Where I steered / what I caught**
- The AI said it would show me the diff of the restored `server.js` before running it, but rewrote and ran the file
  without showing it. It admitted this; I verified the changed lines myself.
- End-of-phase check: I answered the fuel-glitch question correctly (wait for the next readings). I didn't know how
  to find *who* caused the delayed 409 or how to detect a stale ghost leave — the AI explained (match the WS event by
  route version; count joins/leaves per dispatcher id).

---

## Phase 1 — Skeleton & types

**What I asked**
- A skeleton with `src/{transport,domain,store,ui}` and `tests/`, React + Vite, `npm start` running server and client
  together, `npm test` passing, and core types.
- A GLOSSARY.md of key terms, and a (local) interview-prep cheat sheet with every check question and its model answer.

**What the AI produced**
- A plan with 6 design choices and rejected alternatives, which I approved before any code was written.
- `package.json`, strict `tsconfig.json`, Vite config with a dev proxy, domain schemas (`models.ts`, `events.ts`,
  `api.ts`), and 37 tests validating every Phase 0 fixture against the schemas, plus negative cases.
- On its own it caught: `"type": "module"` would break `server.js` (CommonJS); Express 5 changes `req.body` → pinned
  `express@4`; a Vite config warning → `vite.config.mts`; a dense test helper it had written → rewritten plainly.

**Where I steered / what I caught**
- Before approving Zod, I asked whether it is really best practice → an honest comparison (Valibot, ArkType,
  hand-written guards) and its costs.
- End-of-phase check: why Zod as well as TypeScript — partly right; discriminated unions — I asked for an explanation.

---

## Phase 2 — Telemetry pipeline

**What I asked**
- A short checklist and one item at a time (the first plan message was too long).
- TDD: tests first, I approve them, then the logic. Before each piece: explain the problem and list edge cases.

**What the AI produced**
- Pure functions in `src/domain/telemetry/`: ordering by timestamp, GPS batch handling, bounded path, a sensor
  detector registry (speed, fuel) and vehicle profiles — 95 tests, using the Phase 0 fixtures.

**Where I steered / what I caught**
- **Test organization:** the AI went too far (an index README for tests); I rejected it and kept a short header
  comment per test file.
- **Future timestamps:** the AI suggested only documenting the edge case; I chose to code it. When I asked if 60 s is
  safe and said not to over-engineer, it replaced its browser-clock idea with a simpler one: compare against the
  server's own event timestamp.
- **Path size:** "don't we lose the whole path?" → compared tail / thinning / keep-all; I chose the 300-point tail
  and asked to document that a real system keeps full history in a backend DB.
- **Speed limit:** "what happens at 220 km/h for a few seconds?" → per-vehicle-type limits (vehicle profiles).
- **Extensibility:** I asked for new features and vehicle types to be easy → two registries. I asked where the
  vehicle type comes from, since the server doesn't send one → backend fleet data; default `truck`.
- **Fuel:** the first rule only checked drops. I asked about an impossible rise → symmetric, time-based rule. "What
  did we miss?" → out-of-range values, values that keep jumping, drift during the check, alerts on trusted values only.
- **Code review before merge:** found 5 real bugs in the fuel detector (e.g. a held glitch accepted as real after
  4 s; 8 → 0 not caught). The AI wrote failing tests first (5 failed on the old code), then fixed them.
- I asked why the window is 6 s → the server's 2–4 s glitch + one reading interval; in production, tuned from
  logged glitch durations.

---

## Phase 3 — Transport

**What I asked**
- A remaining-time estimate; I pushed back that 18–26 h was too much → faster mode (~10–14 h).
- For each item: what it means, how it will be built, and the options with trade-offs.
- Plain explanations: SSE vs WebSocket, optimistic locking and `If-Match` ("explain like I'm stupid").

**What the AI produced**
- REST client (Result values, timeout, `X-Dispatcher-Id`, `If-Match`), retry with `Retry-After`, circuit breaker,
  SSE client (watchdog, backoff reconnect), WebSocket client (ping/pong, re-registration).

**Where I steered / what I caught**
- Challenged "no retry for writes" → reads retried automatically, writes get a manual Retry, and "my own earlier
  attempt succeeded" is detected.
- Asked whether the server really sends `Retry-After` → yes for its 503; we fall back to backoff without it.
- Noticed the circuit breaker is a **bonus** and asked to finish required work first; kept it because it was
  already started and is part of the grading.
- Chose heartbeat-based dead-connection detection for SSE (20 s) over the AI's 10 s telemetry-based suggestion.
- Declined a temporary "live connection" demo page.
- **Review loop:** I asked for a reviewer subagent and iteration until both agree. Round 1: a real circuit-breaker
  bug + 3 test gaps; round 2: a proxy's HTML 503 treated as invalid data (no retry); round 3: approved.

---

## Phase 4 — Minimal UI

**What I asked**
- What the assignment says about the map before choosing → a simple SVG grid instead of Leaflet.
- A comparison of state libraries → Zustand; a better explanation of "thin store actions + pure domain functions"
  → explained as handler → service → DB.
- A browser check by the AI itself (a subagent driving headless Chrome).

**What the AI produced**
- Store, startup wiring (WS → registered → fleet → SSE, 30 s refresh, breaker-aware probe), 1 s throttled
  rendering, header with connection badges and stale banners, truck list with sensor flags, SVG map, error boundaries.

**Where I steered / what I caught**
- Asked why Truck Golf is always in maintenance and Delta/Juliet always idle → correct server behavior.
- **Spotted a "scribble" on the map path** (GPS batch jitter) → chose a physical-plausibility filter. A real-data test
  then exposed a subtle bug (a batch reading a few ms newer than live moved the marker) → batches are history now.
- Asked to stop table columns from jumping → fixed widths.
- Asked why only the path since connecting is shown → the server's history endpoint returns random data; documented.
- The AI committed one checkpoint without asking first, and admitted it.
- Asked to make sure the interview-prep notes hold the CORRECT answers, not mine → one outdated answer fixed.
- The AI's browser checks raised two false alarms; both were investigated before acting (hot-reload during the
  check; a misread SVG measurement).

---

## Phase 5 — Routes

**What I asked**
- Each design choice explained and approved: one store; seeding the audit log from the routes snapshot (my choice,
  so dispatchers see existing history); status transition rules; no routes on maintenance trucks; "saving…" instead
  of optimistic updates; the ±5 s reassign clash window; which actions need confirmation.
- Mid-phase: work autonomously, surface only important decisions, write everything down.

**What the AI produced**
- Routes state ordered by version, client-side audit log, route rules, conflict description (who/what/options),
  route actions, reassign race checks, and the routes UI (panel, form, dialogs, history).
- It found that the server's immediate 409 can name the route's CREATOR after a reassign, so the 409 body is
  trusted last.

**Where I steered / what I caught**
- Asked whether retries/errors are handled during "saving…" → one request, manual Retry, "already applied" detection.
- While tracing tests, the AI found its own gap (a Retry after a timed-out-but-successful request was reported as
  invalid) and fixed it with a test.
- A two-tab browser test revealed a UX issue: when both dispatchers pressed "Start", the loser was told "your change
  was NOT applied" although the route was exactly as wanted → now "Already done by <who>".
- A code-review subagent ran very long; I stopped it. Verified by 284 unit tests and the two-tab test instead.

---

## Phase 6 + 7 — Presence and vehicle detail panel

**What I asked**
- Verify the remaining required features against the brief. The AI's audit found missing items, including a
  low-fuel alert (implied by "don't trigger false low-fuel alerts"). I asked for it first, tested through the real
  fuel detector, since the server's fuel takes hours to get low.
- The dashboard on one screen (map and trucks smaller, routes beside them).

**What the AI produced**
- Ghost-safe presence (connection counting per id), names everywhere, "who is viewing" tags, an online list; a
  detail drawer with trusted-value charts, mileage, route details and alerts.
- When I said Phase 5 was merged, it found the PR had never been created — after it had already deleted the local
  branch. It restored it from the commit (nothing lost).

**Where I steered / what I caught**
- **Bug I found in the browser:** a second tab showed only itself. The AI had documented this as a known limitation;
  I didn't accept it. Fix: clients answer `dispatcher_joined` by re-sending `viewing_truck` (empty truckId = "not
  viewing"). The AI also used the empty value to announce closing the panel (D53).
- **Ids instead of names** in the newer tab. The AI offered 3 options (name inside the id / shared localStorage /
  keep the limitation). I asked how real systems do it (names from login + a server presence snapshot, e.g. Redis)
  and why the reassign conflict did show a name. The AI explained it only worked because I saw the conflict in the
  OLDER tab — the same gap affects conflicts and the audit log. I chose "name inside the id" (D54) because it fixes
  all of them; localStorage only works within one browser.
- Asked what else to check by hand for these phases → a manual checklist (ghost reload test, reset, alerts, charts).

---

## Phase 8 — Bonuses

**What I asked**
- Go over the assignment PDF and check every requirement. All required items were covered; the AI suggested the
  README next — I chose bonuses first.
- **Observability panel** — details decided by the AI (D55).
- **Filterable fleet view** — my pick ("I think this one will be easy"); the AI chose regions as quadrants (the
  server has none) and dimming instead of hiding on the map (D56).

**Where I steered / what I caught**
- I noticed many trucks at 5% fuel. The AI found the cause in `server.js` (active trucks drain ~30%/hour, never
  refuel, floor 5%) instead of guessing. I asked how to reset, and decided a reset button wasn't worth adding.
- The AI's build runs had accidentally committed the `dist/` build folder; it removed it from the unpushed commits
  and ignored it.

---

## Phase 9 — Tests check, README, final docs

**What I asked**
- I pasted the assignment's test list and asked whether we cover each item.
- The README with every required section.
- Keep the interview-prep file local only (not in the repo), and turn this journal into a real log of how we worked.

**What the AI produced**
- A map from each required test topic to its test files. It named one gap — "real 0% vs glitch" was only covered
  indirectly — and added a direct test.
- README from DECISIONS.md and the code; it checked the quoted UI texts against the real components and fixed the
  ones that didn't match.

**Where I steered / what I caught**
- I asked to make sure the README covers the exact required list → headings renamed to the brief's wording.
- `npm install` and `npm test` were verified clean; `npm start` couldn't be re-checked automatically because my own
  running app held the ports — to be checked by hand.
