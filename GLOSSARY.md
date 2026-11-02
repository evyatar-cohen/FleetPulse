# Glossary

Key terms used in this project, in plain English, with Python comparisons where they help.
Grows as we go — each phase adds the new terms it introduces.

---

## JavaScript / Node.js basics

- **Node.js** — runs JavaScript outside the browser (like the `python` interpreter). Runs our mock server and tools.
- **npm** — package manager for JS (like `pip`). Also runs scripts from `package.json` (`npm start`, `npm test`).
- **package.json** — project file: name, scripts, dependencies (like `pyproject.toml`).
- **dependencies vs devDependencies** — `dependencies` are needed to run the app (react, zod, express);
  `devDependencies` only to build/test it (vite, vitest, typescript). Like main vs dev extras in Python.
- **node_modules/** — folder where npm installs packages (like a virtualenv's `site-packages`). Never committed.
- **package-lock.json** — exact versions of every installed package (like a `poetry.lock`). Committed, so
  everyone installs the same versions.
- **CommonJS vs ESM** — two module systems. CommonJS: `require()` / `module.exports` (old Node style — `server.js`
  uses it). ESM: `import` / `export` (modern standard — our app uses it). Node picks the system per file:
  `.cjs` = CommonJS, `.mjs` = ESM, `.js` = depends on `"type"` in package.json (default CommonJS).
  `.mts` = TypeScript file treated as ESM.
- **Promise** — an object for a result that comes later (like an `asyncio` Future).
  **async / await** — same meaning as in Python: `await` waits for a Promise without blocking the event loop.
- **Callback / event listener** — a function we hand over to be called later, e.g.
  `ws.addEventListener('message', fn)` calls `fn` on every message.
- **Event loop** — JS runs on one thread; I/O completes in the background and its callbacks run one at a time
  (same model as `asyncio`). No two callbacks run at the same moment — but their *order* is not guaranteed.

## TypeScript

- **TypeScript (TS)** — JavaScript plus static types. Types are checked by `tsc` and then erased: at runtime it is
  plain JS (like Python type hints checked by mypy — they don't exist when the code runs).
- **tsc** — the TypeScript compiler / type checker. We only use it to check (`npm run typecheck`); Vite builds.
- **strict mode** — the strictest type-checking settings (e.g. `null` must be handled explicitly).
- **noUncheckedIndexedAccess** — `array[0]` has type `T | undefined`, forcing us to handle "missing" —
  avoids crashes on empty arrays.
- **type vs runtime value** — `type Route = ...` exists only for the checker; a Zod schema is a real object that
  exists at runtime and can check data.
- **Union type** — `A | B`: a value that is one of several types (like `Union[A, B]`).
- **Discriminated union** — a union where every member has a common field with a fixed literal value
  (here: `type`). Checking that field tells TS exactly which member we have:
  `if (msg.type === 'route_updated') { msg.updatedBy }` — TS knows `updatedBy` exists inside that branch.
  Python equivalent: a `Union` of pydantic models with `Literal` `type` fields + a discriminator.
- **Narrowing** — TS refining a type inside an `if` / `switch` branch, as in the example above.
- **Literal type** — a type with exactly one value, e.g. `'telemetry'` (like `Literal['telemetry']`).
- **interface** — describes the shape of an object (like a Python `TypedDict`).
- **`readonly`** — TS forbids changing the array/field in place; enforces immutable updates.
- **Spread `...`** — copies items into a new array/object: `[...a, x]` (like `[*a, x]` in Python),
  `{ ...obj, speed: 0 }` (like `{**obj, 'speed': 0}`).
- **`satisfies`** — checks a value matches a type but keeps its exact shape (e.g. known keys like `truck`).
- **`keyof typeof X`** — the union of an object's key names, e.g. `'truck'`. Used for `VehicleType`.
- **Type guard (`x is T`)** — a function returning boolean that also tells TS the type when true.
- **Generics `<T>`** — a type parameter, like `TypeVar` in Python: `request<T>(schema: ZodType<T>)` returns `T`.
- **`Promise<T>`** — the type of an async result: `async function f(): Promise<Route>` (like `Coroutine[..., Route]`).
- **`Partial<T>`** — the same type with every field optional. Tests use it to override only some fields.

## Validation

- **Zod** — library for runtime validation of data with a schema; the TS type is derived from the schema.
  Closest Python equivalent: **pydantic**.
- **Schema** — description of the expected shape of data (`z.object({ speed: z.number() })`).
- **`z.infer<typeof Schema>`** — derives the TS type from a schema, so type and validator never drift apart.
- **parse vs safeParse** — `parse` throws on invalid data; `safeParse` returns `{ success, data | error }`.
- **"Parse, don't validate"** — check untrusted input once at the boundary (transport) and convert it into
  trusted typed data; inner code never re-checks.
- **Trust boundary** — the point where data enters from outside our control (server messages, user input).

## Design patterns

- **Pure function** — output depends only on inputs; no I/O, no clock, no side effects. Easy to test.
- **Immutable update** — return a new object instead of changing the old one. React notices changes by
  comparing object identity, so mutating in place can leave the UI stale.

- **Reference counting** — keep a count of open things (here: a dispatcher's connections); the thing is "gone"
  only when the count reaches 0. How ghost leaves are handled.
- **Registry** — a list/map the pipeline reads (vehicle profiles, sensor detectors). Adding a feature = adding an
  entry, not editing pipeline code (open/closed principle).

- **Result type** — return `{ ok: true, data } | { ok: false, error }` instead of throwing; the compiler forces
  callers to handle the error (like returning `Ok | Err` instead of `raise`).
- **Dependency injection** — pass a dependency in (e.g. `fetch` into `RestClient`) instead of using a global, so
  tests can pass a fake. Like passing a `requests.Session` into a class.
- **Idempotent** — doing it twice has the same effect as once (GET is; POST create is not). Only idempotent
  operations get automatic retry.

- **State machine** — a fixed set of states with fixed rules for moving between them (fuel detector,
  circuit breaker).
- **Circuit breaker** — after N failures in a row, stop calling a sick service for a cooldown, then let one probe
  through. States: closed (normal) → open (fail fast) → half-open (probe).
- **Exponential backoff** — wait longer after each failure (1 s, 2 s, 4 s…) to give a struggling server room.
- **Getter (`get state()`)** — a property computed on read, like Python `@property`.

- **Composition root** — the one place that creates the objects (clients, store) and wires them together
  (`src/app/startup.ts`). Everything else just receives what it needs.
- **`void promise`** — start an async function without waiting for it (fire-and-forget), and say so explicitly.

## React / frontend

- **React** — UI library: the UI is a function of state; when state changes, React re-renders what changed.
- **Component** — a function that returns UI (`function App(): ReactElement`).
- **JSX / TSX** — HTML-like syntax inside JS/TS (`<h1>FleetPulse</h1>`). `.tsx` = TypeScript file with JSX.
- **Hook** — a function starting with `use` that a component calls to get React features (state, effects, store
  data). Must be called at the top of the component, same order every render.
- **`useState`** — a value the component remembers between renders; setting it causes a redraw.
- **`useEffect` + cleanup** — run code after the component appears (e.g. subscribe); the function it returns runs
  when the component goes away (unsubscribe, clear timers). Like a context manager's `__enter__` / `__exit__`.
- **Throttle** — run at most once per interval; extra calls collapse into one trailing call.
- **StrictMode** — dev-only React wrapper that runs some code twice to reveal bugs (e.g. missing cleanup).
- **Error boundary** — a React component that catches render errors in its children and shows a fallback
  instead of a blank page (must be a class component).
- **Sparkline** — a small, simple line chart without axes, used in the detail panel.
- **Drawer** — a panel that slides over the side of the page (the truck detail panel).
- **SVG** — the browser's vector drawing format (`<circle>`, `<polyline>`); used for the map grid.
- **Props** — the inputs a component receives (`<TruckRow truck={…} />`), like function arguments.
- **`key`** — a stable id React needs on list items to track them between redraws.
- **Vite** — dev server + bundler. Serves the app at `localhost:5173` with instant reload; builds for production.
- **Dev proxy** — Vite forwards `/api` and `/ws` to the mock server on `:3000`, so the client uses relative URLs.
- **CORS** — browser rule blocking calls to another origin unless the server allows it. The mock server sends
  `Access-Control-Allow-Origin: *`; our proxy avoids cross-origin calls anyway.

- **Store (Zustand)** — one place holding app state; `create()` makes it, `getState()` reads it outside React,
  `set()` updates it.
- **Selector** — a function picking the slice a component needs (`(state) => state.trucks['truck_1']`); the
  component redraws only when that slice changes.
- **Object identity** — React/Zustand detect change by "is it the same object?", not by comparing contents.
  Returning the same object = "nothing changed".

## Testing

- **Vitest** — test runner (like `pytest`). `describe` groups tests, `it` is one test, `expect(x).toBe(y)` asserts.
- **`it.each`** — runs one test per input row (like `@pytest.mark.parametrize`).
- **Fixture** — saved real data used by tests (our `fixtures/` folder, captured from the server in Phase 0).
- **Fake timers (`vi.useFakeTimers`)** — tests move time forward by hand (`advanceTimersByTime`), so timeouts
  and backoff are tested instantly.
- **Fake / test double** — a stand-in object (fake `fetch`, fake `EventSource`) the test controls.
- **`import.meta.glob`** — Vite feature that loads many files by pattern at once (used to load all fixtures).

## Networking / protocols

- **REST** — request/response HTTP API (`GET /api/fleet`, `PATCH /api/routes/:id`).
- **SSE (Server-Sent Events)** — one-way stream server → client over a long HTTP response; each message is a
  `data: ...` line followed by a blank line. Used for telemetry.
- **WebSocket (WS)** — two-way persistent connection. Used for presence and route events.
- **`EventSource`** — the browser's SSE client. `readyState`: 0 connecting, 1 open, 2 closed (gave up).
- **Watchdog** — a timer reset by every message; if it fires, the connection is considered dead.
- **sessionStorage / localStorage** — browser key-value storage. sessionStorage is per tab and survives reload;
  localStorage is shared by all tabs of the site. We keep the dispatcher id in sessionStorage.
- **`setInterval` / `setTimeout`** — run a function repeatedly / once after a delay; must be cleared
  (`clearInterval` / `clearTimeout`) on close, or they leak.
- **Heartbeat / ping-pong** — periodic small messages to prove the connection is still alive.
- **Optimistic locking** — every route has `_version`; we send it as `If-Match`; the server rejects with 409 if
  someone changed it in between (same as version-column locking in a DB).
- **`If-Match` header** — the version we last saw, sent with an update; the server rejects (409) if it changed.
- **AbortController** — the standard way to cancel a `fetch`; we use it for the request timeout.
- **`encodeURIComponent`** — escapes text for a URL, so an id like `../reset` can't change the path.
- **409 Conflict** — HTTP status for "your write conflicts with the current state".
- **503 + Retry-After** — "server busy, try again in N seconds".
- **concurrently** — npm tool that runs several commands in one terminal (server + Vite) with prefixed output.
- **base64url** — base64 (bytes → text using A–Z a–z 0–9) with `-` and `_` instead of `+` and `/`, no `=` padding:
  safe inside URLs and HTTP headers. Like Python's `base64.urlsafe_b64encode`. We use it to put the dispatcher's
  name inside their id.
- **`TextEncoder` / `TextDecoder`** — convert text ↔ UTF-8 bytes (Python: `str.encode('utf-8')` / `bytes.decode`).
  Needed because `btoa` alone only accepts Latin-1 characters.
- **Presence snapshot** — a "who's online right now" list a server sends to a newly connected client. Our server
  has none, so our clients announce themselves (D53).
- **Sliding window (rate)** — keep only the last N seconds of samples and compute the rate over them; old samples
  drop off, so the number follows recent traffic and memory stays fixed.
- **Observability** — numbers that show how a running system behaves (message rates, latency, errors, reconnects),
  so problems are visible before users report them.

