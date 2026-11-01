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
