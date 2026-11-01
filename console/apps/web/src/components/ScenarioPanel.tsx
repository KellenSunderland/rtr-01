import type { SceneEvent } from "@argus/protocol";
import { latestSnapshot } from "../lib/scoreboard";
import { Scoreboard } from "./Scoreboard";

function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function KeyValue({ data }: { data: Record<string, unknown> }) {
  const rows = Object.entries(data);
  if (rows.length === 0) return <p className="muted">(empty)</p>;
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{show(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ScenarioPanel({ scenario, events }: { scenario?: string; events: readonly SceneEvent[] }) {
  const snap = latestSnapshot(events);
  return (
    <section className="panel" aria-label="Scenario">
      <h3>Scenario{scenario ? `: ${scenario}` : ""}</h3>
      {scenario === "pickleball_referee" && <Scoreboard events={events} />}
      {snap ? (
        <>
          <h4>State snapshot @ {Math.round(snap.ts_ms / 1000)}s</h4>
          <KeyValue data={snap.state} />
        </>
      ) : (
        scenario !== "pickleball_referee" && <p className="muted">No state.snapshot received.</p>
      )}
    </section>
  );
}
