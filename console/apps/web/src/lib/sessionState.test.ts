import { describe, expect, it } from "vitest";
import { initialSessionState, sessionReducer, type SessionState } from "./sessionState";
import type { ServerMessage } from "@argus/protocol";

const run = (msgs: ServerMessage[], s: SessionState = initialSessionState) =>
  msgs.reduce((st, msg) => sessionReducer(st, { type: "server", msg }), s);

describe("sessionReducer transcript", () => {
  it("renders partials in place and finalizes them", () => {
    const s = run([
      { type: "transcript.partial", text: "hel", ts_ms: 1 },
      { type: "transcript.partial", text: "hello", ts_ms: 2 },
    ]);
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({ text: "hello", partial: true });
    const f = run([{ type: "transcript.final", text: "hello there", ts_ms: 3, utterance_id: "u-1" }], s);
    expect(f.transcript).toHaveLength(1);
    expect(f.transcript[0]).toMatchObject({ text: "hello there", partial: false, utteranceId: "u-1" });
  });
  it("accumulates assistant deltas and ignores text after cancellation", () => {
    let s = run([
      { type: "assistant.text", utterance_id: "u-2", delta: "Hi ", final: false },
      { type: "assistant.text", utterance_id: "u-2", delta: "there", final: false },
    ]);
    expect(s.transcript[0]).toMatchObject({ text: "Hi there", partial: true });
    s = run(
      [
        { type: "assistant.cancelled", utterance_id: "u-2", reason: "barge_in" },
        { type: "assistant.text", utterance_id: "u-2", delta: "!", final: true },
      ],
      s,
    );
    expect(s.transcript[0]).toMatchObject({ text: "Hi there", partial: false, cancelled: true });
  });
  it("keeps markup as plain text", () => {
    const s = run([
      { type: "assistant.text", utterance_id: "u-3", delta: "<img src=x onerror=alert(1)>", final: true },
    ]);
    expect(s.transcript[0]!.text).toBe("<img src=x onerror=alert(1)>");
  });
});
