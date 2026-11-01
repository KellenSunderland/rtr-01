import { describe, expect, it } from "vitest";
import type { SceneEvent } from "@argus/protocol";
import { applyScoreEvent, emptyScoreboard, latestSnapshot, reduceScoreboard } from "./scoreboard";

let n = 0;
const ev = (type: string, ts_ms: number, attrs: Record<string, unknown> = {}): SceneEvent => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  stream_id: "c",
  ts_ms,
  wall_ms: 1,
  type,
  confidence: 1,
  actors: [],
  attrs,
  summary: "",
  scenario: "pickleball_referee",
});

describe("scoreboard", () => {
  it("counts points per team and rallies", () => {
    const sb = reduceScoreboard([
      ev("rally.start", 1),
      ev("point.won", 5, { team: "A" }),
      ev("rally.start", 6),
      ev("point.won", 9, { winner: "b" }),
      ev("rally.start", 10),
      ev("point.won", 12, { team: "a" }),
      ev("ball.bounce", 11),
    ]);
    expect(sb.scores).toEqual({ a: 2, b: 1 });
    expect(sb.rallies).toBe(3);
    expect(sb.rallyActive).toBe(false);
    expect(sb.lastWinner).toBe("a");
    expect(sb.lastPointTs).toBe(12);
  });
  it("orders by ts and dedupes by id", () => {
    const p = ev("point.won", 5, { team: "a" });
    const sb = reduceScoreboard([ev("rally.start", 9), p, p]);
    expect(sb.scores).toEqual({ a: 1 });
    expect(sb.rallyActive).toBe(true); // rally.start (ts 9) after the point (ts 5)
  });
  it("unknown winner and ignored types", () => {
    expect(applyScoreEvent(emptyScoreboard, ev("point.won", 1)).scores).toEqual({ unknown: 1 });
    expect(applyScoreEvent(emptyScoreboard, ev("dog.eating", 1))).toBe(emptyScoreboard);
  });
  it("finds latest state.snapshot", () => {
    expect(latestSnapshot([])).toBeNull();
    const s = latestSnapshot([ev("state.snapshot", 1, { a: 1 }), ev("state.snapshot", 7, { a: 2 })]);
    expect(s).toEqual({ ts_ms: 7, state: { a: 2 } });
  });
});
