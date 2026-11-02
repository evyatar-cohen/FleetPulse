// React hook: read a slice of the store, but re-render at most once per `intervalMs`.
// Data flow: SSE event → store updates immediately → this hook notices → createThrottle() → React state update
// (at most once per second) → component redraws. Use it for fast-changing live data (truck telemetry).
import { useEffect, useState } from 'react';
import { useFleetStore, type FleetState } from '../store/fleetStore';
import { createThrottle } from './throttle';

export const RENDER_INTERVAL_MS: number = 1000;

// `selector` must be a stable function (defined outside the component), so the subscription isn't recreated on
// every render.
export function useThrottledStore<T>(selector: (state: FleetState) => T, intervalMs: number = RENDER_INTERVAL_MS): T {
  const [value, setValue] = useState<T>(() => selector(useFleetStore.getState()));

  useEffect(() => {
    const throttle = createThrottle(() => setValue(selector(useFleetStore.getState())), intervalMs);
    const unsubscribe = useFleetStore.subscribe(() => throttle.trigger());
    // Catch a change that happened between the first render and this subscription.
    throttle.trigger();
    // Cleanup when the component goes away: stop listening and drop any pending redraw.
    return () => {
      unsubscribe();
      throttle.cancel();
    };
  }, [selector, intervalMs]);

  return value;
}
