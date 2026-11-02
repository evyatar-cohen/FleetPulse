// React hook: the current time, refreshed every `intervalMs` — for "updated N s ago" texts that must keep counting
// even when no new data arrives (that is exactly when the age matters).
import { useEffect, useState } from 'react';

export function useNow(intervalMs: number = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
