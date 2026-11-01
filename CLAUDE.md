# FleetPulse — Home Assignment (Senior Frontend)

## Context
This repo is my solution to a senior frontend home assignment: a real-time fleet management dashboard
for a provided mock server. The full assignment is in the PDF in this repo — read it fully before
starting, including the mock server code (`server.js`), which is the source of truth for API behavior.

After submission there is a **defense interview** where I must explain and justify every decision and
every line. Code I can't explain counts against me. This shapes everything below.

## About me — read carefully
- I'm a backend engineer (~5 years, Python, microservices, REST, Redis, RabbitMQ). I know concepts like
  optimistic locking, retries, circuit breakers, event ordering and race conditions well.
- **I have no experience with JavaScript, TypeScript or React.** Treat me as a strong engineer who is new
  to this language and ecosystem.
- Everything is in **English** (conversation, code, docs). English is not my first language — explain
  in **simple, plain English and keep it short**. No jargon without a one-line explanation.
- When a JS/TS/React concept appears for the first time (closures, Promises, `useEffect` + cleanup,
  re-renders, discriminated unions, generics, etc.), explain it briefly, ideally by comparison to Python.

## How we work together
- **One step at a time.** We follow the phases below in order. Within a phase, work in small chunks
  (one module / one concern at a time). Never build several phases in one go.
- **Before writing code** for a chunk: briefly describe what you're about to build, which files, and any
  design choice involved (with the alternative you rejected). Wait for my OK on non-trivial choices.
- **After writing code**: walk me through it — what each part does and why — and tell me how to verify it
  (command to run, what I should see). Then stop and wait for me.
- Don't add libraries, abstractions or features I didn't approve. If you think something is needed, propose it.
- If I ask "why", answer honestly, including weaknesses of the current approach.
- If the assignment, the server code, and my request conflict — point it out instead of guessing.
- **End of each phase — quick check:** ask me 2–3 short questions like an interviewer would
  ("why X and not Y?", "what happens if Z?"). If my answer is wrong or vague, explain and fix it before moving on.

## Code style — clarity over cleverness
- TypeScript, strict mode. Explicit types on function signatures and exported values. No `any`.
- Small, single-purpose functions with descriptive names. Prefer readable over short.
- Avoid dense idioms (long chained one-liners, nested ternaries, clever reduce). A plain loop is fine.
- Comments explain **why**, not what. Every module starts with a short header comment: its responsibility
  and where it sits in the data flow. Every handled server quirk is marked in code: `// QUIRK #N: ...`.
- Consistent folder structure and naming; no dead code, no commented-out code.

## Architecture (agreed direction)
Layers, depending only downward:

```
transport/   SSE client, WebSocket client, REST client (retry + Retry-After, circuit breaker)
             → classes: they own state and lifecycle (connect/close, timers, failure counters)
domain/      pure functions + types: ordering, GPS batch handling, anomaly detection, presence reducer,
             conflict logic → no I/O, no React; this is where most tests live
store/       single state store (e.g. Zustand) wired to transport + domain
ui/          React function components + hooks; throttled rendering
```

- Event types as **discriminated unions**; runtime validation of server payloads (e.g. Zod).
- Extensibility through **registries** (e.g. a list of anomaly detectors, a map of vehicle types) —
  adding one should not require editing existing pipeline code. Not inheritance hierarchies.
- Bounded data (windowed history per truck) — the app must be able to run for hours.

Startup sequence: open WS → `register_dispatcher` → receive `registered` (our dispatcher id) →
load initial state (`GET /api/fleet`, `GET /api/routes`) → open SSE. From then on: listen to SSE + WS,
send REST on user actions.

Stack (propose confirming at Phase 1): React + TypeScript + Vite + Vitest, Leaflet for the map.

## Phases (in this order)
0. **Explore** — run the mock server, inspect the raw SSE stream, REST endpoints and WebSocket.
   Save real sample payloads (normal, `gps_batch`, `_reordered`, speed 999, fuel 0) as test fixtures.
1. **Skeleton & architecture** — project setup, folder structure, core types, `npm start` / `npm test` working.
   `npm start` should start **both** the mock server and the client (e.g. `concurrently`); `express` and `ws`
   must be in `package.json` so `npm install` covers the server too.
2. **Telemetry pipeline + its tests (together)** — GPS batch, out-of-order timestamps, stuck speed sensor,
   fuel glitch. Pure functions in `domain/`, each with tests written alongside.
3. **Transport layer** — SSE with reconnect; REST client with retry respecting `Retry-After` and a
   circuit breaker (3× 503 → degraded mode, cached data marked stale, probe for recovery);
   WebSocket with ping/keepalive and reconnect; `X-Dispatcher-Id` on all requests.
4. **Minimal end-to-end UI** — truck list + simple map, status distinction, throttled rendering.
   Verify data flows before adding features. Visual polish is not graded.
5. **Routes** — create, update status, reassign; always send `If-Match`; on 409 show WHO made the
   conflicting change; confirmation on critical actions; route history/audit log. Test with two tabs.
6. **Dispatcher presence** — register, list active dispatchers, who views which truck, ghost presence.
7. **Vehicle detail panel** — speed/fuel/temp live charts (windowed buffer), mileage, send alert, route details.
8. **Bonuses, by value/cost** — anomaly dashboard → observability panel → 409 side-by-side resolution.
9. **Final docs & cleanup.**

## Things that are easy to miss (verified in server.js)
- `If-Match` is **optional** on the server — if we don't send it, there is no locking at all.
- `PUT /api/routes/:id/reassign` has **no version check** — reassignment races must be detected via WS events.
- `PATCH` can return 409 *after* a 200–1000 ms delay (QUIRK #8) — UI must handle pending state and late conflicts.
  The two 409 bodies differ: the immediate one has `lastModifiedBy`, the delayed one does **not** — get "who"
  from the latest WS `route_updated` / `route_reassigned` or by refetching.
- The server accepts **any** `status` value and any `destination` string — validate input and allowed status
  transitions (assigned → in-progress → completed / cancelled) on the client.
- Mutations need `X-Dispatcher-Id`, which we only get from the WS `registered` message. Keep the id
  (e.g. `sessionStorage`) so a reconnect re-registers with the same identity. `POST .../alert` doesn't
  enforce the header — send it anyway.
- `POST /api/routes` returns 409 with `assignedBy` when the truck is already assigned.
- There is **no audit log endpoint** — build it client-side from `route_assigned` / `route_updated` / `route_reassigned`.
- Mileage is not in SSE or `/api/fleet` — only in `GET /api/fleet/:truckId`.
- Real fuel never drops below 5 on the server, so a sudden 0 that recovers within ~2–4 s is a glitch.
  Detection should be generic (sudden drop + recovery), not hardcoded to the server's numbers.
- Speed stuck at 999 is truck_7 only, but detection should be generic (physically impossible value / repeated identical value), not `if truckId === 'truck_7'`.
- Batch readings carry `_batch` metadata and older timestamps, and arrive alongside normal telemetry for the same truck.
- `dispatcher_left` may arrive ~10 s late (ghost) — and a dispatcher may reconnect with the same id before it arrives.
- `fleet_reset` WS event — local state must reset too.

## Testing
- Vitest, run with `npm test`. Minimum 8 meaningful tests; aim higher for domain logic.
- Required coverage: GPS batch processing, out-of-order timestamps, fuel glitch vs real 0, speed 999 filtering,
  optimistic locking / conflict flow, dispatcher presence with ghost handling.
- Test edge cases and behavior, not "it renders". Use the real fixtures from Phase 0.

## Required deliverables
- `server.js` — **never modify it.**
- `npm install && npm start` must work; `npm test` must pass.
- **README.md**: setup; architecture overview (how data flows from SSE/WS through the code to the UI);
  key technical decisions and trade-offs; how multi-dispatcher conflicts are handled; known issues/limitations;
  what I'd improve with more time.
- **PROMPTS.md** — my AI usage journal (10% of the grade: strategic use, iteration, critical evaluation of AI output).
- **DECISIONS.md** — running log (our working file, feeds the README and my interview prep).

## Ongoing documentation (do this as we go, not at the end)
- At the end of each chunk, **propose** an entry for DECISIONS.md: the decision, alternatives considered,
  why, trade-off. Short. I approve before it's written.
- At the end of each phase, **propose** a PROMPTS.md entry: what I asked, what you produced, what I changed,
  rejected or questioned and why. Keep it factual — don't invent iterations or critiques that didn't happen.
  I'll add my own notes.
- Suggest a commit with a clear message at natural checkpoints; don't commit without asking.
