import { useMemo } from "react";
import type { SceneEvent } from "@argus/protocol";
import { formatClock, MAX_EVENTS } from "../lib/timeline";

export function EventList({ events, onSeek }: { events: SceneEvent[]; onSeek(ts: number): void }) {
  const rows = useMemo(() => events.slice(-MAX_EVENTS).reverse(), [events]);
  return (
    <section className="panel" aria-label="Events">
      <h3>Events ({rows.length})</h3>
      <ul className="events scroll">
        {rows.map((e) => (
          <li key={e.id}>
            <button className="linklike" onClick={() => onSeek(e.ts_ms)}>
              {formatClock(e.ts_ms)}
            </button>{" "}
            <code>{e.stream_id}</code> <b>{e.type}</b> {e.summary}
          </li>
        ))}
      </ul>
    </section>
  );
}
