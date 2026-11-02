// Throttle: run a callback at most once per interval. The first call runs immediately; calls during the interval
// are collapsed into ONE trailing call at the end (so the latest change is never lost).
// Used by the UI to redraw live data at most once per second while the store updates on every SSE event.

export interface Throttled {
  // Signal "something changed".
  trigger: () => void;
  // Cancel a pending trailing call (on unmount).
  cancel: () => void;
}

export function createThrottle(callback: () => void, intervalMs: number): Throttled {
  let lastRunAt: number | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function run(): void {
    pendingTimer = null;
    lastRunAt = Date.now();
    callback();
  }

  return {
    trigger: () => {
      if (pendingTimer !== null) {
        // A trailing run is already scheduled — it will pick up this change too.
        return;
      }
      const elapsed = lastRunAt === null ? intervalMs : Date.now() - lastRunAt;
      if (elapsed >= intervalMs) {
        run();
        return;
      }
      pendingTimer = setTimeout(run, intervalMs - elapsed);
    },
    cancel: () => {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}
