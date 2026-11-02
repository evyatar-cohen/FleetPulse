# FleetPulse — Real-Time Fleet Management Dashboard

A dispatcher dashboard for 12 delivery trucks: live positions and sensor data over SSE, route management over REST
with optimistic locking, and real-time presence of other dispatchers over WebSocket. Built against the provided mock
server (`server.js`, unchanged), which deliberately misbehaves in 8 ways — handling those quirks is the core of
this project.

Stack: React 19 + TypeScript (strict) + Vite, Zustand (state), Zod (runtime validation), Vitest (tests).
The map is a plain SVG coordinate grid (the brief says map quality is not graded).

---

## Setup instructions

Requirements: **Node.js 22+** (tested with Node 24), npm, latest Chrome.

```bash
npm install
npm start        # starts the mock server (port 3000) AND the web app (Vite, http://localhost:5173)
npm test         # runs all unit tests (Vitest)
npm run typecheck
```

Open http://localhost:5173, enter a name, and you are registered as a dispatcher. **Open a second tab with a
different name** to see presence, "who is viewing", and route conflicts between two dispatchers.

- Vite proxies `/api` and `/ws` to the mock server, so the app talks to one origin.
- Each tab is its own dispatcher (identity kept in `sessionStorage`, so a reload keeps the same identity).
- Dev reset: `curl -X POST http://localhost:3000/api/reset` (new random trucks, all routes deleted, for everyone).
- **🛠 Dev** (bottom-left): developer observability panel — SSE messages/s, WS latency, dropped messages, reconnects.

---

## Architecture overview — how data flows from SSE/WS to the UI

Four layers; each depends only on the layers below it.

```
            ┌──────────────────────────────────────────────────────────────────┐
  ui/       │ React components + hooks. Read the store through selectors;      │
            │ live truck data through a 1 s throttled hook.                    │
            └──────────────────────────────▲───────────────────────────────────┘
                                           │ subscribe (selectors)
            ┌──────────────────────────────┴───────────────────────────────────┐
  store/    │ One Zustand store. Actions are thin: call a pure domain function, │
            │ save the result. (trucks, routes, audit log, presence, alerts…)  │
            └──────────────────────────────▲───────────────────────────────────┘
                                           │ typed events
            ┌──────────────────────────────┴───────────────────────────────────┐
  domain/   │ Pure functions + types, no I/O, no React (most tests live here): │
            │ ordering, GPS batch, sensor detectors, routes, conflicts, audit  │
            │ log, route rules, presence. Zod schemas for every payload.       │
            └──────────────────────────────▲───────────────────────────────────┘
                                           │ validated messages
            ┌──────────────────────────────┴───────────────────────────────────┐
  transport/│ Classes that own connections: SseClient, WsClient, RestClient,   │
            │ retry (Retry-After), circuit breaker. Reconnect + keep-alive.    │
            └──────────────────────────────────────────────────────────────────┘
  app/      startup.ts = composition root: creates the clients, wires them to the store, runs the startup order.
```

### Startup order (`src/app/startup.ts`)

1. Open the WebSocket → send `register_dispatcher` (our id carries our name — see D54).
2. `registered` arrives → the REST client gets our `X-Dispatcher-Id`.
3. Load `GET /api/fleet` and `GET /api/routes`.
4. Open the SSE stream.

From then on: SSE and WS events update the store; user actions send REST requests; the fleet snapshot refreshes
every 30 s (and after an SSE or WS gap, and on `fleet_reset`).

### How data flows

**Telemetry (SSE → map/list/charts)**

```
EventSource ─► SseClient: JSON.parse + Zod ──(invalid: dropped + counted)
             ─► store.applySseEvent
             ─► domain/fleet.applyTelemetryEvent
                   ├─ ordering: newer timestamp wins, older = late (QUIRK #5), far-future = rejected
                   ├─ gps_batch = history: fills the path, never moves the marker (QUIRK #1)
                   ├─ path filter: drop points that would need an impossible speed
                   └─ sensor detectors (registry): speed, fuel → TRUSTED value + status (QUIRKS #2, #3)
             ─► store (exact, every event) ─► 1 s throttled hook ─► map, truck list, detail charts
```

**Routes (REST + WS → routes panel/audit log)**

```
User action ─► app/routeActions: client rules first (nothing sent if invalid)
            ─► RestClient: PATCH with If-Match: <version>, X-Dispatcher-Id
            ─► 200 → the server's WS route_updated updates the store (one source of truth)
            ─► 409 → domain/conflicts.describeConflict: WHO changed it and WHAT → conflict dialog
WS route_* events ─► store.applyRouteMessage (applied only if the version is newer) ─► routes + trucks + audit log
```

**Presence (WS → header/truck list)**

```
WS dispatcher_joined / dispatcher_left / dispatcher_viewing ─► domain/presence (connection counting) ─► header, 👁 tags
```

### Extensibility

- **New vehicle type:** one entry in `VEHICLE_PROFILES` (`src/domain/vehicles.ts`) — speed limit, fuel change rate,
  low-fuel threshold. Detectors read limits from the profile; nothing is hardcoded to a truck id or to 999.
- **New sensor check:** one detector module + one line in `SENSOR_DETECTORS` (`src/domain/telemetry/detectors/`).
  The pipeline loops over the registry and never changes.
- **New event type:** add a Zod schema to the discriminated union in `src/domain/events.ts` (its TypeScript type is
  derived from the schema) and handle it where messages are routed (`src/app/startup.ts` / the store).

---

## How each server quirk is handled

| # | Quirk | Handling | Code |
|---|---|---|---|
| 1 | GPS batch (10–30 old readings at once) | Treated as history: fills the path line, never moves the marker or the sensors. One marker per truck. | `domain/telemetry/truckTelemetry.ts`, `path.ts` |
| 2 | Fuel reads 0% for 2–4 s | Rate-of-change rule: an impossible jump is "checking" and the last trusted value is shown. Back to normal → glitch, ignored. Holds 6 s → accepted as real. Low-fuel alert uses only the trusted value. | `detectors/fuel.ts`, `fuelAlert.ts` |
| 3 | Truck #7 speed stuck at 999 | Any speed outside `0..maxSpeedKmh` of the vehicle profile → "⚠ sensor fault", last valid speed shown. Generic, not tied to truck 7. | `detectors/speed.ts`, `vehicles.ts` |
| 4 | Route 409 on version mismatch | Always send `If-Match`. On 409: describe who/what, offer Keep theirs / Apply mine. | `app/routeActions.ts`, `domain/conflicts.ts` |
| 5 | Out-of-order timestamps | Order by reading timestamp, not arrival. An older reading never replaces a newer one. | `domain/telemetry/truckTelemetry.ts` |
| 6 | Ghost presence (leave arrives ~10 s late) | Count open connections per dispatcher id (join +1, leave −1). A late leave after a reconnect doesn't remove them. | `domain/presence.ts` |
| 7 | `GET /api/fleet` 503 (15%) | Retry with `Retry-After` (3 attempts). Circuit breaker: 3 failures → open 10 s → probe. Last data stays, marked **stale**. | `transport/retry.ts`, `circuitBreaker.ts` |
| 8 | PATCH 409 arrives 200–1000 ms later | No optimistic update: the route shows "saving…" until the server answers. The delayed 409 has no "who" → take it from the WS event or reload routes once. | `app/routeActions.ts`, `domain/conflicts.ts` |

---

## Key technical decisions and trade-offs

The full log (56 entries, each with alternatives and trade-offs) is in [DECISIONS.md](DECISIONS.md). The most
important ones:

- **Pure domain layer, thin store (D33).** All logic is data-in → data-out functions, tested without React, mocks or
  a DOM. Same idea as a backend's thin handler → service. *Trade-off:* more small files.
- **Zod at every trust boundary (D4).** SSE, WS and REST payloads are validated; invalid messages are dropped and
  counted, never crash the app. TypeScript types are derived from the schemas (`z.infer`) — one source of truth.
- **Trusted values, not raw values (D15, D16).** The dispatcher sees what the detectors trust, with a flag
  (`⚠ sensor fault`, `⏳ checking`). *Trade-off:* a real sudden fuel change is shown up to 6 s late — never hidden longer.
- **Throttled rendering (D36).** The store applies every event (nothing lost); components re-render at most once per
  second. A GPS batch burst can't freeze the UI. *Trade-off:* the screen can lag up to 1 s.
- **Bounded memory (D13, D40, D52).** Path ≤ 300 points per truck, chart history 150 samples (~5 min), audit log 200
  entries, alerts 50. The app can run for hours with fixed memory.
- **Pessimistic route updates (D43).** Show "saving…" and wait for the server instead of updating first and rolling
  back: with QUIRK #8 a 409 can come a second later, and the status would jump back. The screen updates from the WS
  event, so one source of truth. *Trade-off:* 0.2–1 s wait per action.
- **No automatic retry for writes (D19).** Only reads are retried. A write that timed out gets a manual "Retry"; a
  409 caused by our own earlier attempt is recognised as "already applied". A lost answer can never create a route
  or send an alert twice.
- **Client-side business rules (D41).** The server accepts any status and any destination. The client enforces the
  status flow (assigned → in-progress → completed / cancelled), input limits, and "no route on a maintenance truck".
  *Real system:* the backend must enforce them too.
- **Circuit breaker inside retry (D21).** It counts every request, so 3 failed requests (not 9) open it. While open,
  the last fleet data stays on screen marked stale; SSE positions keep updating.
- **Reconnect forever with backoff (D24, D27).** SSE: no message for 20 s (heartbeat is 15 s) → reconnect. WS: ping
  every 10 s, no pong in 5 s → reconnect. Backoff 1 s → 30 s cap. After a gap the fleet snapshot is reloaded (the
  server can't replay missed events).
- **No libraries where a few lines do (D18, D26, D31).** Native `fetch`, `EventSource`, `WebSocket`; SVG map and
  sparklines. Dependencies: React, Zustand, Zod (+ express/ws for the mock server).

---

## How multi-dispatcher conflicts are handled

The brief's story: two trucks sent to the same job, a route changed by two people, and "nobody knew who did what".

**Updating a route (optimistic locking).** Every `PATCH` sends `If-Match: <route version we hold>`. If someone
changed the route first, the server answers 409. The dispatcher then sees a dialog, for example:

> **Someone else changed this route first** — **Bob** started it while your change was being saved. Your change was
> **not** applied. *(table: Now (theirs) vs. Yours — status, truck)* [Keep theirs] [Apply mine anyway]

- **Who changed it** comes from the most reliable source: our audit-log entry with that exact version (from the WS
  event) → our stored route → the 409 body. The 409 body alone is not reliable: the delayed 409 has no "who", and
  after a reassign the immediate one names the route's creator. If "who" is still unknown, routes are reloaded once.
- **Apply mine anyway** re-sends with the *current* version, and only if the transition is still allowed (you can't
  "start" a route they already completed).
- **Both wanted the same thing** (e.g. both pressed Start): "Already done — Bob started it just before you" — not a
  scary conflict.
- **Our own earlier attempt won** (a retry after a timeout): "already applied".

**Creating a route.** `POST` returns 409 with `assignedBy` when the truck already has a route →
*"This truck was just given route route_3 by Bob."* Trucks that can't take a route are greyed out in the form with
the reason.

**Reassigning.** `PUT /reassign` has **no version check** on the server, so the client can only narrow the window
and make clashes visible: the dialog remembers the version it opened with and warns "changed since you opened it —
by Bob" before sending; after sending, another dispatcher's reassign of the same route within ±5 s is shown as
"Bob also reassigned this route at the same time". The real fix is a version check on the server.

**Seeing each other.** The header lists who is online (by name); a 👁 tag shows which truck each dispatcher is
viewing. The route history (audit log) shows who did what and when — built on the client from WS events, because the
server has no audit endpoint.

**Confirmations** on critical actions only: cancel, complete and reassign (not on Start, so people don't learn to
click OK without reading).

---

## Known issues or limitations

- **Presence depends on clients announcing themselves.** The server never sends a "who's online" list and only tells
  *existing* clients about a new one. Our clients answer every `dispatcher_joined` by re-sending `viewing_truck`
  (empty = not viewing) so a newcomer learns about them (D53). Edge case: if someone online before you reconnects and
  their late (ghost) leave arrives, they may disappear from your list until their next action.
- **Names travel inside the dispatcher id** (`dispatcher_<random>.<base64url name>`, D54), because only
  `dispatcher_joined` carries a name. It's a client convention, not a server feature; ids made by other clients show
  as ids.
- **Reassign races are detected, not prevented** (no server-side version check).
- **The audit log starts at page load** plus what the routes snapshot shows (the latest change of each kind per
  route); earlier intermediate changes are unknown. Real fix: a server-side audit log.
- **Fuel:** a real sudden change is shown up to 6 s late; below ~3% a drop to 0 fits the allowed rate and isn't
  flagged as a glitch. A truck whose clock is > 60 s ahead looks frozen (future readings are rejected).
- **The mock server drains fuel and never refuels:** after 1–3 hours most active trucks sit at 5% (the server's floor).
  That is real data, so the low-fuel flag is correct. `POST /api/reset` restores fresh trucks.
- **Regions** in the fleet filter are four quadrants around the server's city center (copied — no API exposes it).
- **`GET /api/telemetry/history` is not used:** the mock returns random data. Charts show what this tab has received
  since it opened (up to ~5 min per truck).
- **React components have no DOM tests;** their logic lives in tested pure helpers. Verified manually in two tabs.
- **`server.js` was restored from the PDF** (copy-paste broke `===`, `||`, `&&`); only those characters were fixed (D1).

---

## What I'd improve with more time

- **Server-side** (if I could change it): a presence snapshot on connect (in Redis with TTLs for several server
  instances), names from login instead of the id, `If-Match` on reassign, an audit-log endpoint, event ids for SSE
  replay after a gap.
- **Tests:** component tests (React Testing Library) and an end-to-end two-dispatcher test (Playwright).
- **Full 409 side-by-side resolution** (bonus): the conflict dialog already shows "now (theirs) vs. yours" for status
  and truck; next step is every field, with a per-field choice.
- **Map:** a real street map (Leaflet) and geofencing alerts on the same projection.
- **Keyboard shortcuts** for switching trucks and quick actions.
- **Monitoring:** send the counters the observability panel already shows to a metrics system.

### What I'd monitor in production

- SSE: messages/s per client (drop to 0 = outage), reconnect rate, dropped (invalid) messages.
- WS: ping latency, reconnect rate, time from `register_dispatcher` to `registered`.
- REST: 503 rate, circuit-breaker opens and time spent open, request latency, timeouts.
- Business signals: 409 rate per endpoint (how often dispatchers clash), reassign races detected, sensor-fault and
  fuel-glitch rates per truck (a truck with many faults needs a sensor repair), "stale data" time per session.
- Front-end errors caught by the error boundaries (e.g. Sentry).

---

## Testing

`npm test` — 344 tests, all in Vitest, mostly against pure domain functions with **real payloads captured from the
mock server** (`fixtures/`, produced by `scripts/capture-fixtures.mjs`).

| Requirement | Tests |
|---|---|
| GPS batch processing | `tests/domain/telemetry/gpsBatch.test.ts`, `pathPlausibility.test.ts` |
| Out-of-order timestamps | `tests/domain/telemetry/ordering.test.ts` |
| Fuel: real 0% vs glitch | `tests/domain/telemetry/fuelDetector.test.ts`, `fuelAlert.test.ts` |
| Speed 999 filtering | `tests/domain/telemetry/speedDetector.test.ts` |
| Optimistic locking / conflicts | `tests/domain/conflicts.test.ts`, `tests/app/routeActions.test.ts`, `tests/transport/restClient.test.ts` |
| Presence with ghost handling | `tests/domain/presence.test.ts` (incl. the captured reconnect + late-leave sequence) |
| Transport resilience | `retry`, `circuitBreaker`, `sseClient`, `wsClient` tests (fake timers, fake sockets) |
| Startup wiring | `tests/app/startup.test.ts` (whole app with fake fetch/EventSource/WebSocket) |

---

## Project files

| File | What it is |
|---|---|
| `server.js` | The provided mock server — unchanged. |
| `src/` | The app (`transport/`, `domain/`, `store/`, `ui/`, `app/`). Every module starts with a header comment; each handled quirk is marked `// QUIRK #N`. |
| `tests/`, `fixtures/` | Tests and real captured server payloads. |
| [DECISIONS.md](DECISIONS.md) | Every decision with alternatives and trade-offs. |
| [PROMPTS.md](PROMPTS.md) | AI usage journal. |
| [GLOSSARY.md](GLOSSARY.md) | Terms used in the code, in plain English. |
| [INTERVIEW_PREP.md](INTERVIEW_PREP.md) | Questions and answers about the design. |
