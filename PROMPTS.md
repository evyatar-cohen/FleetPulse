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

---

## Phase 4 — Minimal UI

**How I worked with the AI this phase**
- Asked what the assignment says about the map before choosing → chose a simple SVG grid over Leaflet
  ("map quality is not graded").
- Approved Zustand after comparing it with React Context, Redux and a hand-written store; asked for a better
  explanation of "thin store actions + pure domain functions" → explained as handler → service → DB.
- Asked for a browser check by the AI itself → a Sonnet subagent drove headless Chrome via the DevTools protocol.

**What the AI produced**
- Store (Zustand) + fleet domain functions, startup wiring (`startApp`: WS → registered → fleet → SSE, 30 s refresh,
  breaker-aware probe scheduling, reloads on fleet_reset / SSE reconnect), throttled rendering (1 s), header with
  connection badges and stale banners, truck list with sensor flags, SVG map, name form, error boundaries.

**What I found / questioned / changed**
- Looking at the running app, I asked why Truck Golf is always maintenance at 0 km/h and why Delta/Juliet are
  always idle → correct server behavior (fault flag appears only during stuck episodes; idle trucks need a route).
- I spotted a "scribble" on the map path → GPS batch jitter. I chose the AI's option B: a physically-plausible path
  filter. A real-data test then failed and exposed a subtle bug (a batch reading a few ms newer than the live one
  moved the marker) → batch is now treated as history.
- I asked "what do you mean by history — the marker must still update?" → clarified: live telemetry moves the
  marker every 2 s; the batch only fills the path.
- I asked to stop the table columns from moving → fixed widths + tabular digits.
- I asked why only the path since connecting is shown → the server keeps no history and its history endpoint
  returns random data; documented as a limitation.
- The AI committed one checkpoint without asking first, and admitted it.
- Code review (reviewer subagent): approved in round 1, no findings (it was cut off once by a usage limit and resumed).
- I asked to make sure INTERVIEW_PREP holds the CORRECT answers, not mine → confirmed the structure and fixed
  one stale model answer (Q7, outdated after the batch-as-history change).
- The AI's browser checks raised two false alarms, both investigated before acting: badges "disconnected"
  (caused by Vite hot-reload while the AI edited files during the check) and a "long first path segment"
  (measured directly: ≤ 11 m — the subagent's script misread the SVG).

**My notes**
- _(add your own notes here)_

---

## Phase 5 — Routes

**How I worked with the AI this phase**
- Approved each design choice (one store; seeding the audit log from the routes snapshot — my choice so dispatchers
  see existing history; transition rules; blocking routes on maintenance trucks; pessimistic "saving…"; ±5 s reassign
  clash window; which actions need confirmation).
- Mid-phase I told the AI to work autonomously and only surface important/architecture decisions, writing every
  decision and trade-off into DECISIONS.md and INTERVIEW_PREP.md so I don't lose information.
- Asked to skip review subagents in later phases unless the AI is genuinely unsure (cost/time).

**What the AI produced**
- Routes state with version ordering, client-side audit log, route rules, conflict description (who/what/options),
  route actions with outcomes, reassign race checks, and the routes UI (panel, form, dialogs, history).
- It found that server.js's immediate 409 can name the route's CREATOR after a reassign
  (`lastModifiedBy || assignedBy`), so the 409 body is trusted last.

**What I questioned / changed**
- Asked whether retries/errors are handled in the "saving…" time → clarified: one request, no automatic retry for
  writes, manual Retry, and "already applied" detection.
- While tracing tests the AI found its own gap (a manual Retry after a successful timed-out request was reported as
  "invalid") and fixed it with a test.
- A two-tab browser test (two dispatchers in headless Chrome) passed all 5 scenarios and revealed a UX issue: when
  both pressed "Start", the loser was told "your change was NOT applied" although the route was as wanted → now
  "Already done by <who>".

- A code-review subagent ran very long; I asked to stop it. Phase 5 was verified by 284 unit tests and the
  two-tab browser test instead.

**My notes**
- _(add your own notes here)_

---

## Phase 6 + 7 — Presence and vehicle detail panel

**How I worked with the AI this phase**
- Asked to verify the remaining required features against the brief. The AI's audit found missing items: a low-fuel
  alert (the brief's "don't trigger false low-fuel alerts" implies one), presence, the presence/ghost test, the detail
  panel, and the README. I asked to add the low-fuel alert first and to verify it with tests, since the server's fuel
  takes hours to get low.
- Asked for the dashboard to fit one screen (map and trucks smaller, routes beside them).
- Phase 6 and 7 were built together (both start from "click a truck") while I let the AI work autonomously.

**What the AI produced**
- Ghost-safe presence (connection counting per id), names instead of ids everywhere, "who is viewing" tags, an online
  list; a detail drawer with trusted-value sparklines, mileage, route details, alerts (send + list).
- When I said Phase 5 was merged, the AI found the PR had never been created (the branch was only pushed) — after it
  had already deleted the local branch; it restored it from the commit (nothing lost) and based the next branch on it.
- **Bug I found in the browser:** a second tab showed only itself, not the dispatcher in the first tab. The AI had
  documented this as a known limitation ("server never sends an online list"); I didn't accept it as a limitation. We
  agreed on a fix: clients answer `dispatcher_joined` by re-sending `viewing_truck` (empty truckId = "not viewing").
  The AI also used the empty value to announce closing the detail panel, removing another documented limitation (D53).
- After that fix, the newer tab showed the older dispatcher by **id**, not name. The AI listed 3 options (name inside
  the id / shared localStorage / keep the limitation). I asked how this works in real life (answer: names from login
  + a server presence snapshot, e.g. in Redis) and why the reassign conflict showed a name. The AI explained it only
  worked because the conflict was seen in the OLDER tab — the same gap applies to conflicts and the audit log. I chose
  "name inside the id" (D54) because it fixes all of them; localStorage was rejected because it only works in one browser.

**My notes**
- _(add your own notes here)_

---

## Phase 8 — Bonuses

**How I worked with the AI this phase**
- Asked the AI to go over the assignment PDF and check every requirement. It mapped each basic requirement to the
  code (all covered) and listed what's left: README, final checks, bonuses. It suggested README first; I chose bonuses first.
- I noticed many trucks at 5% fuel. Instead of guessing, the AI found the cause in `server.js`: active trucks drain
  ~30%/hour, never refuel, floor 5%. I asked how to reset; I decided not to add a reset button (not a bonus).
- Observability panel: built with the AI deciding details autonomously (D55).
- Filterable fleet view: I picked it as the next bonus ("I think this one will be easy"). The AI chose the details
  (D56): regions as quadrants because the server has no regions, the map dims instead of hiding.

**My notes**
- _(add your own notes here)_

---

## Phase 9 — Tests check, README, final docs

**How I worked with the AI this phase**
- Before the docs, I pasted the assignment's test list and asked if we cover each item. The AI mapped every item to
  its test file and named one gap: "real 0% vs glitch" was only covered indirectly. It added a direct test (a low
  truck drops to 0% and stays → accepted after the window, low-fuel alert on).
- README: the AI wrote it from DECISIONS.md and the code, then checked the quoted UI texts (conflict dialog,
  "truck taken" message) against the real components and fixed the ones that didn't match.
- Clean-install check (`npm install && npm start`, `npm test`) run before submission.

**My notes**
- _(add your own notes here)_

