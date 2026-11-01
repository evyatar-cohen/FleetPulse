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
