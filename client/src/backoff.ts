/**
 * Reconnection delay: exponential (0.5 s → 30 s) with "equal jitter", so that
 * 20 000 clients reconnecting after a server restart do not come back all at once.
 */
export function backoff(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (base / 2) * random());
}
