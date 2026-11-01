"""Pydantic mirror of ``console/packages/protocol/src/index.ts`` (source of truth: the TS file)."""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

PROTOCOL_VERSION = 1
STREAM_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
EVENT_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$")

StreamId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9_-]*$")]


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")

    def wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json", exclude_none=True)


class BBox(_M):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(ge=0, le=1)
    h: float = Field(ge=0, le=1)


class Actor(_M):
    label: str
    track_id: str | None = None
    bbox: BBox | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class FrameRef(_M):
    stream_id: StreamId
    ts_ms: int = Field(ge=0)


class SceneEvent(_M):
    id: str
    stream_id: StreamId
    ts_ms: int = Field(ge=0)
    wall_ms: int = Field(ge=0)
    type: str = Field(pattern=EVENT_TYPE_RE.pattern)
    confidence: float = Field(ge=0, le=1)
    actors: list[Actor] = Field(default_factory=list)
    attrs: dict[str, Any] = Field(default_factory=dict)
    summary: str = Field(max_length=500)
    frame_ref: FrameRef | None = None
    scenario: str


class MinuteSummary(_M):
    stream_id: StreamId
    minute_start_ms: int = Field(ge=0)
    wall_ms: int = Field(ge=0)
    text: str = Field(max_length=2000)
    event_count: int = Field(ge=0)


StreamState = Literal["starting", "live", "stalled", "stopped", "error"]


class StreamInfo(_M):
    id: StreamId
    name: str = Field(max_length=100)
    uri: str = Field(max_length=2048)
    state: StreamState
    fps: float | None = Field(default=None, ge=0)
    last_frame_wall_ms: int | None = None


class _Audio(_M):
    seq: int = Field(ge=0)
    ts_ms: int = Field(ge=0)
    sample_rate: Literal[16000, 24000, 48000]
    pcm16_b64: str


# ---------------------------------------------------------- client -> server


class SessionStart(_M):
    type: Literal["session.start"]
    scenario: str
    stream_ids: list[StreamId] = Field(min_length=1, max_length=16)
    locale: str = "en-US"


class ClientAudio(_Audio):
    type: Literal["audio.chunk"]


class TextMessage(_M):
    type: Literal["text.message"]
    text: str = Field(min_length=1, max_length=4000)


class BargeIn(_M):
    type: Literal["control.barge_in"]


class Stop(_M):
    type: Literal["control.stop"]


class HistoryQuery(_M):
    type: Literal["history.query"]
    request_id: str
    stream_id: StreamId | None = None
    since_ms: int = Field(ge=0)
    until_ms: int = Field(ge=0)
    text: str | None = Field(default=None, max_length=500)
    limit: int = Field(default=50, ge=1, le=200)


ClientMessage = Annotated[
    SessionStart | ClientAudio | TextMessage | BargeIn | Stop | HistoryQuery,
    Field(discriminator="type"),
]
client_message_adapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)

# ---------------------------------------------------------- server -> client


class SessionStarted(_M):
    type: Literal["session.started"] = "session.started"
    session_id: str
    scenario: str
    streams: list[StreamInfo]
    server_wall_ms: int


class TranscriptPartial(_M):
    type: Literal["transcript.partial"] = "transcript.partial"
    text: str
    ts_ms: int


class TranscriptFinal(_M):
    type: Literal["transcript.final"] = "transcript.final"
    text: str
    ts_ms: int
    utterance_id: str


class AssistantText(_M):
    type: Literal["assistant.text"] = "assistant.text"
    utterance_id: str
    delta: str
    final: bool


class AssistantAudio(_Audio):
    type: Literal["assistant.audio"] = "assistant.audio"
    utterance_id: str


class AssistantCancelled(_M):
    type: Literal["assistant.cancelled"] = "assistant.cancelled"
    utterance_id: str
    reason: Literal["barge_in", "stop", "error"]


class EventMessage(_M):
    type: Literal["event"] = "event"
    event: SceneEvent


class SummaryMessage(_M):
    type: Literal["summary"] = "summary"
    summary: MinuteSummary


class StreamStatus(_M):
    type: Literal["stream.status"] = "stream.status"
    stream: StreamInfo


class HistoryResult(_M):
    type: Literal["history.result"] = "history.result"
    request_id: str
    events: list[SceneEvent]
    summaries: list[MinuteSummary]
    truncated: bool


class ErrorMessage(_M):
    type: Literal["error"] = "error"
    code: Literal["bad_request", "unauthorized", "quota", "not_found", "upstream", "internal"]
    message: str
    request_id: str | None = None


ServerMessage = Annotated[
    SessionStarted
    | TranscriptPartial
    | TranscriptFinal
    | AssistantText
    | AssistantAudio
    | AssistantCancelled
    | EventMessage
    | SummaryMessage
    | StreamStatus
    | HistoryResult
    | ErrorMessage,
    Field(discriminator="type"),
]
server_message_adapter: TypeAdapter[ServerMessage] = TypeAdapter(ServerMessage)


class ScenarioEventType(_M):
    type: str
    description: str


class ScenarioInfo(_M):
    name: str
    description: str
    event_types: list[ScenarioEventType]
    tools: list[str]
