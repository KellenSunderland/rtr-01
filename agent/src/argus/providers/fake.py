"""Deterministic, offline fakes for every provider Protocol."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from argus.providers.base import (
    ChatEvent,
    ChatMessage,
    ChatOptions,
    Detection,
    Done,
    Frame,
    Observation,
    TextDelta,
    ToolCall,
    ToolCallEvent,
    ToolSpec,
    Transcript,
    Usage,
)
from argus.providers.registry import register


def _load_json(path: str | Path | None, inline: Any = None) -> Any:
    if inline is not None:
        return inline
    if path:
        return json.loads(Path(path).read_text())
    return None


# ------------------------------------------------------------------ chat


class FakeChatModel:
    """Scripted + rule-based chat model.

    * ``responses`` (cfg): list of reply strings consumed in order, if given.
    * Otherwise rules: tool result -> echo it; "what happened"/"last"/"when" -> ``what_happened`` /
      ``search_history``; "score" -> ``current_score`` (when offered); "see"/"right now" ->
      ``describe_now``; "summarize" system prompt -> deterministic summary; else echo.
    * ``token_delay_s`` paces the stream (used to test barge-in).
    """

    name = "fake-chat"

    def __init__(
        self,
        responses: Sequence[str] | None = None,
        token_delay_s: float = 0.0,
    ) -> None:
        self._responses = list(responses or [])
        self._i = 0
        self.token_delay_s = token_delay_s
        self.calls = 0

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        tools: Sequence[ToolSpec] = (),
        options: ChatOptions | None = None,
    ) -> AsyncIterator[ChatEvent]:
        self.calls += 1
        names = {t.name for t in tools}
        last = messages[-1] if messages else ChatMessage(role="user")
        call: ToolCall | None = None
        if self._responses and last.role != "tool":
            text = self._responses[min(self._i, len(self._responses) - 1)]
            self._i += 1
        elif last.role == "tool" and last.tool_result is not None:
            body = last.tool_result.content
            text = ("Sorry, that failed: " if last.tool_result.is_error else "Here is what I found: ") + body[
                :600
            ]
        else:
            system = " ".join(m.content for m in messages if m.role == "system")
            if not tools and "summarize" in system.lower():
                lines = [ln.lstrip("- ").strip() for ln in last.content.splitlines() if ln.strip()]
                text = f"Summary of {len(lines)} events: " + "; ".join(lines)[:400]
            else:
                text, call = self._rules(last.content, names)
        try:
            for word in re.findall(r"\S+\s*", text):
                if self.token_delay_s:
                    await asyncio.sleep(self.token_delay_s)
                else:
                    await asyncio.sleep(0)
                yield TextDelta(word)
            if call is not None:
                yield ToolCallEvent(call)
                yield Done("tool_use", Usage(10, len(text) // 4))
            else:
                yield Done("end_turn", Usage(10, len(text) // 4))
        except asyncio.CancelledError:
            raise

    @staticmethod
    def _rules(user: str, names: set[str]) -> tuple[str, ToolCall | None]:
        t = user.lower()
        cid = "call_" + hashlib.blake2b(t.encode(), digest_size=4).hexdigest()
        if "score" in t and "current_score" in names:
            return "", ToolCall(cid, "current_score", {})
        if any(k in t for k in ("what happened", "last", "when")):
            if "what happened" in t and "what_happened" in names:
                m = re.search(r"(\d+)\s*min", t)
                return "", ToolCall(cid, "what_happened", {"minutes_back": int(m.group(1)) if m else 5})
            if "search_history" in names:
                return "", ToolCall(cid, "search_history", {"query": user})
        if any(k in t for k in ("see", "right now", "describe")) and "describe_now" in names:
            return "", ToolCall(cid, "describe_now", {})
        return f"You said: {user}", None


# ---------------------------------------------------------------- vision


class FakeVisionModel:
    """Replays fixture observations by ``stream_id`` and ``[from_ms, to_ms)`` frame-time window.

    Fixture: ``{"timeline": [{"stream_id", "from_ms", "to_ms", "event_type", "confidence", "summary",
    "actors": [...], "attrs": {...}}]}``. Each entry is emitted at most once. Anything else: none.
    """

    name = "fake-vision"

    def __init__(self, timeline: list[dict[str, Any]] | None = None) -> None:
        self.timeline = timeline or []
        self._emitted: set[int] = set()
        self.calls = 0

    async def observe(
        self,
        frames: Sequence[Frame],
        *,
        system_prompt: str,
        event_types: Sequence[str],
        context: str = "",
    ) -> list[Observation]:
        self.calls += 1
        out: list[Observation] = []
        for fi, fr in enumerate(frames):
            for idx, e in enumerate(self.timeline):
                if idx in self._emitted or e.get("stream_id") != fr.meta.stream_id:
                    continue
                if e["from_ms"] <= fr.meta.ts_ms < e["to_ms"]:
                    self._emitted.add(idx)
                    out.append(
                        Observation(
                            event_type=e["event_type"],
                            confidence=float(e.get("confidence", 0.9)),
                            summary=e.get("summary", ""),
                            actors=tuple(e.get("actors", ())),
                            attrs=dict(e.get("attrs", {})),
                            frame_index=fi,
                        )
                    )
        return [o for o in out if o.event_type in event_types or o.event_type == "none"]


class FakeDetector:
    """Fixture boxes: ``{"boxes": [{"stream_id","from_ms","to_ms","label","confidence","bbox","track_id"}]}``."""

    name = "fake-detector"

    def __init__(self, boxes: list[dict[str, Any]] | None = None) -> None:
        self.boxes = boxes or []

    async def detect(self, frame: Frame) -> list[Detection]:
        return [
            Detection(b["label"], float(b.get("confidence", 0.9)), tuple(b["bbox"]), b.get("track_id"))  # type: ignore[arg-type]
            for b in self.boxes
            if b.get("stream_id", frame.meta.stream_id) == frame.meta.stream_id
            and b.get("from_ms", 0) <= frame.meta.ts_ms < b.get("to_ms", 2**62)
        ]


# -------------------------------------------------------------- embedder

_TOKEN = re.compile(r"[a-z0-9]+")


def _stem(w: str) -> str:
    for suf in ("ing", "es", "s", "ed"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: -len(suf)]
    return w


class FakeEmbedder:
    """Hashing bag-of-words (+ char trigrams) embedder; deterministic unit vectors."""

    name = "fake-embedder"

    def __init__(self, dim: int = 64) -> None:
        self.dim = dim

    def _vec(self, text: str) -> list[float]:
        v = np.zeros(self.dim, dtype=np.float64)
        toks = [_stem(t) for t in _TOKEN.findall(text.lower())]
        for t in toks:
            self._add(v, "w:" + t, 1.0)
            for i in range(len(t) - 2):
                self._add(v, "c:" + t[i : i + 3], 0.15)
        n = float(np.linalg.norm(v))
        if n == 0:
            self._add(v, "empty", 1.0)
            n = float(np.linalg.norm(v))
        return (v / n).tolist()

    def _add(self, v: np.ndarray, key: str, w: float) -> None:
        h = int.from_bytes(hashlib.blake2b(key.encode(), digest_size=8).digest(), "little")
        v[h % self.dim] += w if (h >> 40) & 1 else -w

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]


# ------------------------------------------------------------------- ASR


class FakeASR:
    """Maps PCM energy bursts to fixture utterances.

    Each ``transcribe`` call is one utterance segment: if the audio contains energy above
    ``energy_threshold`` (RMS, int16 units) the next fixture utterance is returned: words are revealed
    progressively as partials (one per chunk with speech) and a final at end of input.
    """

    name = "fake-asr"

    def __init__(self, utterances: Sequence[str] | None = None, energy_threshold: float = 500.0) -> None:
        self.utterances = list(utterances or ["what happened in the last minute"])
        self.energy_threshold = energy_threshold
        self._n = 0

    async def transcribe(
        self,
        audio: AsyncIterator[bytes],
        *,
        sample_rate: int,
        language: str = "en",
    ) -> AsyncIterator[Transcript]:
        total = 0
        speech = 0
        words: list[str] | None = None
        shown = 0
        async for chunk in audio:
            n = len(chunk) // 2
            if n == 0:
                continue
            a = np.frombuffer(chunk[: n * 2], dtype="<i2").astype(np.float64)
            total += n
            if float(np.sqrt(np.mean(a * a))) >= self.energy_threshold:
                speech += n
                if words is None:
                    words = self.utterances[self._n % len(self.utterances)].split()
                    self._n += 1
                # reveal at most 1 word per 100 ms of speech and always keep at least one back
                target = min(len(words) - 1, max(1, speech * 10 // sample_rate)) if len(words) > 1 else 0
                if target > shown:
                    shown = target
                    yield Transcript(
                        " ".join(words[:shown]), False, 0, int(total * 1000 // sample_rate), 0.5
                    )
        if words is not None:
            yield Transcript(" ".join(words), True, 0, int(total * 1000 // sample_rate), 0.95)


# ------------------------------------------------------------------- TTS


class FakeTTS:
    """440 Hz tone; duration = 60 ms per character (clamped 0.2..15 s); 16 kHz PCM16."""

    name = "fake-tts"
    sample_rate = 16000

    def __init__(self, chunk_ms: int = 100, realtime: bool = False) -> None:
        self.chunk_ms = chunk_ms
        self.realtime = realtime

    @staticmethod
    def duration_s(text: str) -> float:
        return min(15.0, max(0.2, 0.06 * len(text)))

    async def synthesize(self, text: str, *, voice: str = "default") -> AsyncIterator[bytes]:
        total = int(self.duration_s(text) * self.sample_rate)
        step = self.sample_rate * self.chunk_ms // 1000
        pos = 0
        while pos < total:
            n = min(step, total - pos)
            t = (np.arange(pos, pos + n)) / self.sample_rate
            pcm = (0.3 * 32767 * np.sin(2 * math.pi * 440.0 * t)).astype("<i2")
            yield pcm.tobytes()
            pos += n
            await asyncio.sleep(self.chunk_ms / 1000 if self.realtime else 0)


# -------------------------------------------------------------- factories


def _chat(cfg: dict[str, Any]) -> FakeChatModel:
    return FakeChatModel(cfg.get("responses"), float(cfg.get("token_delay_s", 0.0)))


def _vision(cfg: dict[str, Any]) -> FakeVisionModel:
    data = _load_json(cfg.get("fixture"), cfg.get("timeline_data"))
    if isinstance(data, dict):
        data = data.get("timeline", [])
    return FakeVisionModel(data)


def _detector(cfg: dict[str, Any]) -> FakeDetector:
    data = _load_json(cfg.get("fixture"), cfg.get("boxes_data"))
    if isinstance(data, dict):
        data = data.get("boxes", [])
    return FakeDetector(data)


def _embedder(cfg: dict[str, Any]) -> FakeEmbedder:
    return FakeEmbedder(int(cfg.get("dim", 64)))


def _asr(cfg: dict[str, Any]) -> FakeASR:
    utt = cfg.get("utterances")
    if utt is None and cfg.get("fixture"):
        d = _load_json(cfg["fixture"])
        utt = d.get("utterances") if isinstance(d, dict) else d
    return FakeASR(utt, float(cfg.get("energy_threshold", 500.0)))


def _tts(cfg: dict[str, Any]) -> FakeTTS:
    return FakeTTS(int(cfg.get("chunk_ms", 100)), bool(cfg.get("realtime", False)))


register("chat", "fake", _chat)
register("vision", "fake", _vision)
register("detector", "fake", _detector)
register("embedder", "fake", _embedder)
register("asr", "fake", _asr)
register("tts", "fake", _tts)

__all__ = [
    "FakeASR",
    "FakeChatModel",
    "FakeDetector",
    "FakeEmbedder",
    "FakeTTS",
    "FakeVisionModel",
]
