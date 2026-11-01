import type { SceneEvent } from "@argus/protocol";
import { useMemo } from "react";
import { reduceScoreboard } from "../lib/scoreboard";

export function Scoreboard({ events }: { events: readonly SceneEvent[] }) {
  const sb = useMemo(() => reduceScoreboard(events), [events]);
  const sides = Object.entries(sb.scores).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="scoreboard" aria-label="Scoreboard">
      {sides.length === 0 && <span className="muted">No points yet</span>}
      {sides.map(([side, pts]) => (
        <div key={side} className={`score${sb.lastWinner === side ? " last" : ""}`}>
          <span className="side">{side}</span>
          <span className="pts">{pts}</span>
        </div>
      ))}
      <div className="muted small">
        rallies: {sb.rallies}
        {sb.rallyActive ? " (in play)" : ""}
      </div>
    </div>
  );
}
