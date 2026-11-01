export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor: number;
  /** 0..1 fraction of random jitter subtracted from the delay (0 = deterministic). */
  jitter: number;
}
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 15000, factor: 2, jitter: 0.2 };

/** Delay before retry number `attempt` (0-based). `rand` returns [0,1). */
export function backoffDelay(
  attempt: number,
  o: BackoffOptions = DEFAULT_BACKOFF,
  rand: () => number = Math.random,
): number {
  const raw = Math.min(o.maxMs, o.baseMs * Math.pow(o.factor, Math.max(0, attempt)));
  return Math.round(raw * (1 - o.jitter * rand()));
}
