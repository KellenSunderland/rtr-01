/**
 * @argus/protocol — the wire contract shared by console (TS), gateway (Go) and
 * agent (Python). This file is the source of truth; Go and Python mirror it by
 * hand (see host/CONTRACTS.md). Every message is a JSON object with a `type`.
 *
 * Time: `ts_ms` is the gateway's monotonic session clock in milliseconds
 * (0 = session start); `wall_ms` is Unix epoch milliseconds. Never subtract one
 * from the other.
 */
import { z } from "zod";

// ------------------------------------------------------------------ common

export const StreamId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
export const SessionId = z.string().uuid();

export const BBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
}); // normalized to frame size

export const Actor = z.object({
  label: z.string(), // "person" | "dog" | "ball" | pack-defined
  track_id: z.string().optional(),
  bbox: BBox.optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const FrameRef = z.object({ stream_id: StreamId, ts_ms: z.number().int().nonnegative() });

/** A typed, timestamped thing that happened in a stream. `type` comes from the
 *  active scenario pack's taxonomy (e.g. "dog.eating", "ball.bounce"). */
export const SceneEvent = z.object({
  id: z.string().uuid(),
  stream_id: StreamId,
  ts_ms: z.number().int().nonnegative(),
  wall_ms: z.number().int().nonnegative(),
  type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  confidence: z.number().min(0).max(1),
  actors: z.array(Actor).default([]),
  attrs: z.record(z.string(), z.unknown()).default({}),
  summary: z.string().max(500),
  frame_ref: FrameRef.optional(),
  scenario: z.string(),
});

export const MinuteSummary = z.object({
  stream_id: StreamId,
  minute_start_ms: z.number().int().nonnegative(),
  wall_ms: z.number().int().nonnegative(),
  text: z.string().max(2000),
  event_count: z.number().int().nonnegative(),
});

export const StreamState = z.enum(["starting", "live", "stalled", "stopped", "error"]);

export const StreamInfo = z.object({
  id: StreamId,
  name: z.string().max(100),
  uri: z.string().max(2048),
  state: StreamState,
  fps: z.number().nonnegative().optional(),
  last_frame_wall_ms: z.number().int().optional(),
});

export const AudioChunk = z.object({
  seq: z.number().int().nonnegative(),
  ts_ms: z.number().int().nonnegative(),
  sample_rate: z.union([z.literal(16000), z.literal(24000), z.literal(48000)]),
  pcm16_b64: z.string(), // little-endian mono int16, base64
});

// ------------------------------------------------- client -> server (WS)

export const SessionStart = z.object({
  type: z.literal("session.start"),
  scenario: z.string(),
  stream_ids: z.array(StreamId).min(1).max(16),
  locale: z.string().default("en-US"),
});
export const ClientAudio = AudioChunk.extend({ type: z.literal("audio.chunk") });
export const TextMessage = z.object({ type: z.literal("text.message"), text: z.string().min(1).max(4000) });
export const BargeIn = z.object({ type: z.literal("control.barge_in") });
export const Stop = z.object({ type: z.literal("control.stop") });
export const HistoryQuery = z.object({
  type: z.literal("history.query"),
  request_id: z.string(),
  stream_id: StreamId.optional(),
  since_ms: z.number().int().nonnegative(),
  until_ms: z.number().int().nonnegative(),
  text: z.string().max(500).optional(), // semantic query; omitted = time window only
  limit: z.number().int().min(1).max(200).default(50),
});

export const ClientMessage = z.discriminatedUnion("type", [
  SessionStart,
  ClientAudio,
  TextMessage,
  BargeIn,
  Stop,
  HistoryQuery,
]);

// ------------------------------------------------- server -> client (WS)

export const SessionStarted = z.object({
  type: z.literal("session.started"),
  session_id: SessionId,
  scenario: z.string(),
  streams: z.array(StreamInfo),
  server_wall_ms: z.number().int(),
});
export const TranscriptPartial = z.object({
  type: z.literal("transcript.partial"),
  text: z.string(),
  ts_ms: z.number().int(),
});
export const TranscriptFinal = z.object({
  type: z.literal("transcript.final"),
  text: z.string(),
  ts_ms: z.number().int(),
  utterance_id: z.string(),
});
export const AssistantText = z.object({
  type: z.literal("assistant.text"),
  utterance_id: z.string(),
  delta: z.string(),
  final: z.boolean(),
});
export const AssistantAudio = AudioChunk.extend({
  type: z.literal("assistant.audio"),
  utterance_id: z.string(),
});
export const AssistantCancelled = z.object({
  type: z.literal("assistant.cancelled"),
  utterance_id: z.string(),
  reason: z.enum(["barge_in", "stop", "error"]),
});
export const EventMessage = z.object({ type: z.literal("event"), event: SceneEvent });
export const SummaryMessage = z.object({ type: z.literal("summary"), summary: MinuteSummary });
export const StreamStatus = z.object({ type: z.literal("stream.status"), stream: StreamInfo });
export const HistoryResult = z.object({
  type: z.literal("history.result"),
  request_id: z.string(),
  events: z.array(SceneEvent),
  summaries: z.array(MinuteSummary),
  truncated: z.boolean(),
});
export const ErrorMessage = z.object({
  type: z.literal("error"),
  code: z.enum(["bad_request", "unauthorized", "quota", "not_found", "upstream", "internal"]),
  message: z.string(),
  request_id: z.string().optional(),
});

export const ServerMessage = z.discriminatedUnion("type", [
  SessionStarted,
  TranscriptPartial,
  TranscriptFinal,
  AssistantText,
  AssistantAudio,
  AssistantCancelled,
  EventMessage,
  SummaryMessage,
  StreamStatus,
  HistoryResult,
  ErrorMessage,
]);

// ------------------------------------------------------------- REST

export const CreateStreamRequest = z.object({
  id: StreamId,
  name: z.string().max(100),
  uri: z.string().max(2048),
});
export const CreateSessionRequest = z.object({
  scenario: z.string(),
  stream_ids: z.array(StreamId).min(1).max(16),
});
export const SessionInfo = z.object({
  id: SessionId,
  scenario: z.string(),
  stream_ids: z.array(StreamId),
  created_wall_ms: z.number().int(),
  state: z.enum(["open", "closed"]),
});
export const ScenarioInfo = z.object({
  name: z.string(),
  description: z.string(),
  event_types: z.array(z.object({ type: z.string(), description: z.string() })),
  tools: z.array(z.string()),
});

export type SceneEvent = z.infer<typeof SceneEvent>;
export type MinuteSummary = z.infer<typeof MinuteSummary>;
export type StreamInfo = z.infer<typeof StreamInfo>;
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;
export type SessionInfo = z.infer<typeof SessionInfo>;
export type ScenarioInfo = z.infer<typeof ScenarioInfo>;

export const PROTOCOL_VERSION = 1;
