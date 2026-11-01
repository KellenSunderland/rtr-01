import { useMemo, useRef, useState } from "react";
import type { MinuteSummary, SceneEvent } from "@argus/protocol";
import {
  bucketByMinute,
  filterByType,
  fromFraction,
  inWindow,
  lastHour,
  toFraction,
  MAX_EVENTS,
} from "../lib/timeline";

const formatWall = (ms: number) => new Date(ms).toLocaleTimeString();

/** All times here are wall-clock epoch ms (nowMs, seekTs, onSeek). */
interface Props {
  events: SceneEvent[];
  summaries: MinuteSummary[];
  nowMs: number;
  seekTs: number | null;
  onSeek(ts: number | null): void;
}

export function Timeline({ events, summaries, nowMs, seekTs, onSeek }: Props) {
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const w = useMemo(() => lastHour(nowMs), [nowMs]);

  const allTypes = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);
  const filtered = useMemo(() => filterByType(events, types), [events, types]);
  const buckets = useMemo(
    () =>
      bucketByMinute(
        filtered.map((e) => ({ ts_ms: e.wall_ms, type: e.type })),
        w,
        summaries.map((x) => ({ ...x, minute_start_ms: Math.floor(x.wall_ms / 60000) * 60000 })),
      ),
    [filtered, w, summaries],
  );
  const max = Math.max(1, ...buckets.map((b) => b.count));

  const tsAt = (clientX: number): number | null => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    return fromFraction((clientX - r.left) / r.width, w);
  };

  const describe = (ts: number): string => {
    const span = w.endMs - w.startMs;
    const tol = span * 0.01;
    let best: SceneEvent | null = null;
    for (const e of filtered) {
      if (!inWindow(e.wall_ms, w)) continue;
      if (
        Math.abs(e.wall_ms - ts) <= tol &&
        (!best || Math.abs(e.wall_ms - ts) < Math.abs(best.wall_ms - ts))
      )
        best = e;
    }
    if (best) return `${formatWall(best.wall_ms)} ${best.type}: ${best.summary}`;
    const sum = summaries.find((s) => Math.floor(s.wall_ms / 60000) === Math.floor(ts / 60000));
    return sum ? `${formatWall(sum.wall_ms)} summary: ${sum.text}` : formatWall(ts);
  };

  return (
    <section className="panel timeline" aria-label="Timeline">
      <h3>
        Timeline{" "}
        <span className="muted small">
          last hour · {events.length}/{MAX_EVENTS} events
        </span>
        {seekTs !== null && (
          <button className="small" onClick={() => onSeek(null)}>
            Back to live
          </button>
        )}
      </h3>
      <div className="chips">
        {allTypes.map((t) => (
          <button
            key={t}
            className={`chip${types.has(t) ? " on" : ""}`}
            aria-pressed={types.has(t)}
            onClick={() => {
              const n = new Set(types);
              if (n.has(t)) n.delete(t);
              else n.add(t);
              setTypes(n);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div
        className="track"
        ref={track}
        role="slider"
        aria-label="Timeline scrubber"
        aria-valuemin={w.startMs}
        aria-valuemax={w.endMs}
        aria-valuenow={seekTs ?? w.endMs}
        tabIndex={0}
        onMouseMove={(e) => {
          const ts = tsAt(e.clientX);
          const r = track.current?.getBoundingClientRect();
          if (ts !== null && r) setHover({ x: e.clientX - r.left, text: describe(ts) });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const ts = tsAt(e.clientX);
          if (ts !== null) onSeek(ts);
        }}
      >
        {buckets.map((b) => (
          <div
            key={b.startMs}
            className="bar"
            style={{
              left: `${toFraction(Math.max(b.startMs, w.startMs), w) * 100}%`,
              width: `${(100 * (Math.min(b.startMs + 60000, w.endMs) - Math.max(b.startMs, w.startMs))) / Math.max(1, w.endMs - w.startMs)}%`,
              height: `${(b.count / max) * 100}%`,
            }}
          />
        ))}
        {seekTs !== null && inWindow(seekTs, w) && (
          <div className="cursor" style={{ left: `${toFraction(seekTs, w) * 100}%` }} />
        )}
        {hover && (
          <div className="tip" style={{ left: Math.min(hover.x, 400) }}>
            {hover.text}
          </div>
        )}
      </div>
      <div className="axis muted small">
        <span>{formatWall(w.startMs)}</span>
        <span>{formatWall(w.endMs)}</span>
      </div>
    </section>
  );
}
