"""Provider protocols — the only way the agent talks to models.

Every model-ish dependency (chat LLM, vision model, object detector, embedder,
ASR, TTS) is behind one of these Protocols. The base install ships *fakes*
(deterministic, fixture-driven). Real providers (Anthropic, OpenAI, Ollama,
ultralytics, faster-whisper, Kokoro, sentence-transformers, Voyage) are added
as modules under ``argus.providers.<name>`` that register with the registry
in :mod:`argus.providers.registry`; callers never import a provider directly.

Conventions
-----------
* All methods are ``async``; blocking providers run in a thread via
  ``asyncio.to_thread``.
* Audio is mono PCM16 little-endian ``bytes`` with an explicit ``sample_rate``.
* Frames are JPEG ``bytes`` plus a :class:`FrameMeta`.
* Providers raise :class:`ProviderError` (or a subclass) — never provider-SDK
  exceptions — so callers can handle retries/fallbacks uniformly.
* Providers must be safe to call concurrently from multiple tasks.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable


class ProviderError(Exception):
    """Base class for provider failures."""

    def __init__(self, message: str, *, retryable: bool = False, provider: str = "") -> None:
        super().__init__(message)
        self.retryable = retryable
        self.provider = provider


class ProviderRateLimited(ProviderError):
    def __init__(self, message: str, *, retry_after_s: float | None = None, provider: str = "") -> None:
        super().__init__(message, retryable=True, provider=provider)
        self.retry_after_s = retry_after_s


class ProviderUnavailable(ProviderError):
    pass


# ----------------------------------------------------------------- chat


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]  # JSON Schema


@dataclass(frozen=True, slots=True)
class ImagePart:
    jpeg: bytes
    detail: Literal["low", "high"] = "low"


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ToolResult:
    call_id: str
    content: str
    is_error: bool = False


@dataclass(frozen=True, slots=True)
class ChatMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str = ""
    images: tuple[ImagePart, ...] = ()
    tool_calls: tuple[ToolCall, ...] = ()  # assistant only
    tool_result: ToolResult | None = None  # tool only


@dataclass(frozen=True, slots=True)
class ChatOptions:
    max_tokens: int = 1024
    temperature: float | None = None
    stop: tuple[str, ...] = ()
    json_schema: dict[str, Any] | None = None  # structured output request, if supported
    effort: Literal["low", "medium", "high"] | None = None


@dataclass(frozen=True, slots=True)
class TextDelta:
    text: str


@dataclass(frozen=True, slots=True)
class ToolCallEvent:
    call: ToolCall


@dataclass(frozen=True, slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None


@dataclass(frozen=True, slots=True)
class Done:
    stop_reason: Literal["end_turn", "tool_use", "max_tokens", "cancelled", "refusal"]
    usage: Usage = field(default_factory=Usage)


ChatEvent = TextDelta | ToolCallEvent | Done


@runtime_checkable
class ChatModel(Protocol):
    """Streaming chat completion with tool calling."""

    name: str

    def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        tools: Sequence[ToolSpec] = (),
        options: ChatOptions | None = None,
    ) -> AsyncIterator[ChatEvent]:
        """Yield TextDelta / ToolCallEvent and exactly one terminal Done.

        Cancellation: the caller cancels the task; implementations must close
        network streams promptly and must not yield after cancellation.
        """
        ...


# --------------------------------------------------------------- vision


@dataclass(frozen=True, slots=True)
class FrameMeta:
    stream_id: str
    ts_ms: int
    wall_ms: int
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class Frame:
    jpeg: bytes
    meta: FrameMeta


@dataclass(frozen=True, slots=True)
class Observation:
    """Structured output of a vision call; validated against the scenario taxonomy by the caller."""

    event_type: str
    confidence: float
    summary: str
    actors: tuple[dict[str, Any], ...] = ()
    attrs: dict[str, Any] = field(default_factory=dict)
    frame_index: int = 0  # which frame of the input batch this refers to


@runtime_checkable
class VisionModel(Protocol):
    name: str

    async def observe(
        self,
        frames: Sequence[Frame],
        *,
        system_prompt: str,
        event_types: Sequence[str],
        context: str = "",
    ) -> list[Observation]:
        """Describe what is happening across ``frames`` (ordered, same stream).

        Must only return ``event_type`` values from ``event_types`` (or
        ``"none"``). ``context`` carries recent history text for continuity.
        """
        ...


# ------------------------------------------------------------- detector


@dataclass(frozen=True, slots=True)
class Detection:
    label: str
    confidence: float
    bbox: tuple[float, float, float, float]  # normalized x, y, w, h
    track_id: str | None = None


@runtime_checkable
class Detector(Protocol):
    name: str

    async def detect(self, frame: Frame) -> list[Detection]: ...


# ------------------------------------------------------------- embedder


@runtime_checkable
class Embedder(Protocol):
    name: str
    dim: int

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Return one unit-normalized vector of length ``dim`` per input."""
        ...


# ------------------------------------------------------------------ ASR


@dataclass(frozen=True, slots=True)
class Transcript:
    text: str
    final: bool
    start_ms: int
    end_ms: int
    confidence: float | None = None


@runtime_checkable
class ASR(Protocol):
    name: str

    def transcribe(
        self,
        audio: AsyncIterator[bytes],
        *,
        sample_rate: int,
        language: str = "en",
    ) -> AsyncIterator[Transcript]:
        """Consume PCM16 chunks; yield partial (final=False) and final transcripts."""
        ...


# ------------------------------------------------------------------ TTS


@runtime_checkable
class TTS(Protocol):
    name: str
    sample_rate: int

    def synthesize(self, text: str, *, voice: str = "default") -> AsyncIterator[bytes]:
        """Yield PCM16 chunks at ``sample_rate``. Cancelling the consumer must stop synthesis."""
        ...


ProviderKind = Literal["chat", "vision", "detector", "embedder", "asr", "tts"]
