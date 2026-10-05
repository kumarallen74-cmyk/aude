import { useEffect, useState } from 'react';

/** The current time as render input, refreshed every `intervalMs` (keeps renders pure: no Date.now() in render). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return now;
}
