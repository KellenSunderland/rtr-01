import type { MinuteSummary, SceneEvent } from "@argus/protocol";

export const MINUTE_MS = 60_000;
export const WINDOW_MS = 60 * MINUTE_MS;
export const MAX_EVENTS = 2000;

/** Half-open window on the session clock: `startMs` inclusive, `endMs` exclusive. */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** The last hour ending at `nowMs`; clamped so startMs >= 0 (session clock starts at 0). */
export function lastHour(nowMs: number): TimeWindow {
  const endMs = Math.max(0, Math.floor(nowMs));
  return { startMs: Math.max(0, endMs - WINDOW_MS), endMs };
}

/** start <= ts < end */
export function inWindow(ts: number, w: TimeWindow): boolean {
  return ts >= w.startMs && ts < w.endMs;
}

/** Fraction [0,1) of `ts` across the window; clamped. Empty window -> 0. */
export function toFraction(ts: number, w: TimeWindow): number {
  const span = w.endMs - w.startMs;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (ts - w.startMs) / span));
}

/** Inverse of toFraction; result is an integer ms inside [start, end-1] (or start if empty). */
export function fromFraction(f: number, w: TimeWindow): number {
  const span = w.endMs - w.startMs;
  if (span <= 0) return w.startMs;
  const ts = w.startMs + Math.round(Math.min(1, Math.max(0, f)) * span);
  return Math.min(ts, Math.max(w.startMs, w.endMs - 1));
}

export interface Bucket {
  /** Minute-aligned start (multiple of 60000 on the session clock). Buckets may begin before window.startMs. */
  startMs: number;
  count: number;
  byType: Record<string, number>;
  summaries: MinuteSummary[];
}

/**
 * Bucket events (and summaries by `minute_start_ms`) into minute-aligned buckets covering the window.
 * Buckets run from floor(start/60000) to floor((end-1)/60000) inclusive; items outside the window
 * are ignored. An empty window yields no buckets.
 */
export function bucketByMinute(
  events: readonly Pick<SceneEvent, "ts_ms" | "type">[],
  w: TimeWindow,
  summaries: readonly MinuteSummary[] = [],
): Bucket[] {
  if (w.endMs <= w.startMs) return [];
  const first = Math.floor(w.startMs / MINUTE_MS);
  const last = Math.floor((w.endMs - 1) / MINUTE_MS);
  const buckets: Bucket[] = [];
  for (let m = first; m <= last; m++) buckets.push({ startMs: m * MINUTE_MS, count: 0, byType: {}, summaries: [] });
  for (const e of events) {
    if (!inWindow(e.ts_ms, w)) continue;
    const b = buckets[Math.floor(e.ts_ms / MINUTE_MS) - first];
    if (!b) continue;
    b.count++;
    b.byType[e.type] = (b.byType[e.type] ?? 0) + 1;
  }
  for (const s of summaries) {
    const b = buckets[Math.floor(s.minute_start_ms / MINUTE_MS) - first];
    if (b) b.summaries.push(s);
  }
  return buckets;
}

/** Empty `types` set means "no filter". */
export function filterByType<T extends { type: string }>(items: readonly T[], types: ReadonlySet<string>): T[] {
  return types.size === 0 ? [...items] : items.filter((i) => types.has(i.type));
}

/** Insert events by id (dedupe, later wins), sort by ts_ms then id, keep the newest `cap`. */
export function mergeEvents(existing: readonly SceneEvent[], incoming: readonly SceneEvent[], cap = MAX_EVENTS): SceneEvent[] {
  const byId = new Map<string, SceneEvent>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  const all = [...byId.values()].sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id));
  return all.length > cap ? all.slice(all.length - cap) : all;
}

export function mergeSummaries(existing: readonly MinuteSummary[], incoming: readonly MinuteSummary[]): MinuteSummary[] {
  const byKey = new Map<string, MinuteSummary>();
  for (const s of [...existing, ...incoming]) byKey.set(`${s.stream_id}@${s.minute_start_ms}`, s);
  return [...byKey.values()].sort((a, b) => a.minute_start_ms - b.minute_start_ms);
}

export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
