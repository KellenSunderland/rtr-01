import { describe, expect, it } from "vitest";
import * as P from "../src/index.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const stream = { id: "cam1", name: "Cam", uri: "rtsp://x/y", state: "live", fps: 5 };
const ev = {
  id: uuid, stream_id: "cam1", ts_ms: 10, wall_ms: 1700000000000, type: "dog.eating",
  confidence: 0.9, summary: "dog eats", scenario: "home_monitor",
};
const sum = { stream_id: "cam1", minute_start_ms: 0, wall_ms: 1, text: "t", event_count: 1 };
const audio = { seq: 0, ts_ms: 0, sample_rate: 16000, pcm16_b64: "AAA=" };

type Fx = { valid: unknown; invalid: unknown };
const server: Record<string, Fx> = {
  "session.started": {
    valid: { type: "session.started", session_id: uuid, scenario: "s", streams: [stream], server_wall_ms: 1 },
    invalid: { type: "session.started", session_id: "nope", scenario: "s", streams: [], server_wall_ms: 1 },
  },
  "transcript.partial": { valid: { type: "transcript.partial", text: "hi", ts_ms: 1 }, invalid: { type: "transcript.partial", ts_ms: 1 } },
  "transcript.final": {
    valid: { type: "transcript.final", text: "hi", ts_ms: 1, utterance_id: "u-1" },
    invalid: { type: "transcript.final", text: "hi", ts_ms: 1 },
  },
  "assistant.text": {
    valid: { type: "assistant.text", utterance_id: "u-1", delta: "a", final: false },
    invalid: { type: "assistant.text", utterance_id: "u-1", delta: "a", final: "no" },
  },
  "assistant.audio": {
    valid: { type: "assistant.audio", utterance_id: "u-1", ...audio },
    invalid: { type: "assistant.audio", ...audio, sample_rate: 44100, utterance_id: "u-1" },
  },
  "assistant.cancelled": {
    valid: { type: "assistant.cancelled", utterance_id: "u-1", reason: "barge_in" },
    invalid: { type: "assistant.cancelled", utterance_id: "u-1", reason: "because" },
  },
  event: { valid: { type: "event", event: ev }, invalid: { type: "event", event: { ...ev, type: "Bad Type" } } },
  summary: { valid: { type: "summary", summary: sum }, invalid: { type: "summary", summary: { ...sum, event_count: -1 } } },
  "stream.status": { valid: { type: "stream.status", stream }, invalid: { type: "stream.status", stream: { ...stream, state: "weird" } } },
  "history.result": {
    valid: { type: "history.result", request_id: "r", events: [ev], summaries: [sum], truncated: false },
    invalid: { type: "history.result", request_id: "r", events: [ev] },
  },
  error: {
    valid: { type: "error", code: "quota", message: "m" },
    invalid: { type: "error", code: "nope", message: "m" },
  },
};
const client: Record<string, Fx> = {
  "session.start": {
    valid: { type: "session.start", scenario: "s", stream_ids: ["cam1"] },
    invalid: { type: "session.start", scenario: "s", stream_ids: [] },
  },
  "audio.chunk": { valid: { type: "audio.chunk", ...audio }, invalid: { type: "audio.chunk", ...audio, seq: -1 } },
  "text.message": { valid: { type: "text.message", text: "hi" }, invalid: { type: "text.message", text: "" } },
  "control.barge_in": { valid: { type: "control.barge_in" }, invalid: { type: "control.barge" } },
  "control.stop": { valid: { type: "control.stop" }, invalid: { type: "control.start" } },
  "history.query": {
    valid: { type: "history.query", request_id: "r", since_ms: 0, until_ms: 5 },
    invalid: { type: "history.query", request_id: "r", since_ms: 0, until_ms: 5, limit: 1000 },
  },
};

function optionTypes(u: { options: Array<{ shape: { type: { value: string } } }> }) {
  return u.options.map((o) => o.shape.type.value);
}

describe("ServerMessage", () => {
  it("has a fixture for every message type", () => {
    expect(Object.keys(server).sort()).toEqual(optionTypes(P.ServerMessage as never).sort());
  });
  for (const [t, fx] of Object.entries(server)) {
    it(`${t}: valid parses, invalid rejected`, () => {
      expect(P.ServerMessage.safeParse(fx.valid).success).toBe(true);
      expect(P.ServerMessage.safeParse(fx.invalid).success).toBe(false);
    });
  }
  it("rejects unknown type and non-objects", () => {
    expect(P.ServerMessage.safeParse({ type: "zzz" }).success).toBe(false);
    expect(P.ServerMessage.safeParse("x").success).toBe(false);
    expect(P.ServerMessage.safeParse(null).success).toBe(false);
  });
});

describe("ClientMessage", () => {
  it("has a fixture for every message type", () => {
    expect(Object.keys(client).sort()).toEqual(optionTypes(P.ClientMessage as never).sort());
  });
  for (const [t, fx] of Object.entries(client)) {
    it(`${t}: valid parses, invalid rejected`, () => {
      expect(P.ClientMessage.safeParse(fx.valid).success).toBe(true);
      expect(P.ClientMessage.safeParse(fx.invalid).success).toBe(false);
    });
  }
  it("applies defaults", () => {
    const m = P.ClientMessage.parse(client["session.start"]!.valid);
    expect(m.type === "session.start" && m.locale).toBe("en-US");
  });
});

describe("common + REST schemas", () => {
  const cases: Array<[string, { safeParse(x: unknown): { success: boolean } }, unknown, unknown]> = [
    ["StreamId", P.StreamId, "cam_1-a", "Cam"],
    ["SessionId", P.SessionId, uuid, "x"],
    ["BBox", P.BBox, { x: 0, y: 0, w: 1, h: 1 }, { x: 2, y: 0, w: 1, h: 1 }],
    ["Actor", P.Actor, { label: "dog" }, { label: 1 }],
    ["FrameRef", P.FrameRef, { stream_id: "a", ts_ms: 0 }, { stream_id: "a", ts_ms: -1 }],
    ["SceneEvent", P.SceneEvent, ev, { ...ev, confidence: 2 }],
    ["MinuteSummary", P.MinuteSummary, sum, { ...sum, text: "x".repeat(2001) }],
    ["StreamState", P.StreamState, "live", "dead"],
    ["StreamInfo", P.StreamInfo, stream, { ...stream, id: "" }],
    ["AudioChunk", P.AudioChunk, audio, { ...audio, pcm16_b64: 1 }],
    ["CreateStreamRequest", P.CreateStreamRequest, { id: "a", name: "n", uri: "u" }, { id: "A", name: "n", uri: "u" }],
    ["CreateSessionRequest", P.CreateSessionRequest, { scenario: "s", stream_ids: ["a"] }, { scenario: "s", stream_ids: [] }],
    ["SessionInfo", P.SessionInfo, { id: uuid, scenario: "s", stream_ids: ["a"], created_wall_ms: 1, state: "open" }, { id: uuid, scenario: "s", stream_ids: [], created_wall_ms: 1, state: "x" }],
    ["ScenarioInfo", P.ScenarioInfo, { name: "n", description: "d", event_types: [{ type: "a.b", description: "x" }], tools: [] }, { name: "n" }],
  ];
  for (const [name, schema, ok, bad] of cases) {
    it(name, () => {
      expect(schema.safeParse(ok).success).toBe(true);
      expect(schema.safeParse(bad).success).toBe(false);
    });
  }
  it("every exported zod schema is covered by a fixture above", () => {
    const covered = new Set([
      ...cases.map((c) => c[0]),
      "ClientMessage", "ServerMessage",
      "SessionStart", "ClientAudio", "TextMessage", "BargeIn", "Stop", "HistoryQuery",
      "SessionStarted", "TranscriptPartial", "TranscriptFinal", "AssistantText", "AssistantAudio",
      "AssistantCancelled", "EventMessage", "SummaryMessage", "StreamStatus", "HistoryResult", "ErrorMessage",
    ]);
    const exported = Object.entries(P).filter(([, v]) => typeof v === "object" && v !== null && "safeParse" in v).map(([k]) => k);
    expect(exported.filter((k) => !covered.has(k))).toEqual([]);
  });
});
