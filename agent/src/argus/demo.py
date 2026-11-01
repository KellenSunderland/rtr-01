"""``argus demo``: run a whole session against pack fixtures with no gateway (the main integration test).

Frames are synthesized from the pack's ``fixtures/demo.json``; vision, ASR, chat, TTS and embedder are
the deterministic fakes. A scripted conversation (typed lines + one synthetic spoken burst) runs after
perception has drained, and the transcript is printed.
"""

from __future__ import annotations

import asyncio
import base64
import json
import math
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from argus.clock import SessionClock
from argus.conversation.session import Session, SessionDeps
from argus.memory.store import MemoryStore
from argus.metrics import Metrics
from argus.perception.sanitize import Sanitizer
from argus.providers.base import Frame, FrameMeta
from argus.providers.registry import make_all
from argus.scenarios.registry import Pack, PackRegistry

FAKE_JPEG = b"\xff\xd8\xff\xc0\x00\x0b\x08\x01\x68\x02\x80\x01\x01\x11\x00\xff\xd9"  # 640x360 SOF stub


@dataclass(slots=True)
class DemoResult:
    pack: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    transcript: list[tuple[str, str]] = field(default_factory=list)  # (role, text)
    events: list[dict[str, Any]] = field(default_factory=list)
    state: dict[str, Any] = field(default_factory=dict)
    metrics: Metrics = field(default_factory=Metrics)
    sanitized: int = 0


def _burst(ms: int, rate: int = 16000, amp: float = 0.5) -> bytes:
    n = rate * ms // 1000
    t = np.arange(n) / rate
    return (amp * 32767 * np.sin(2 * math.pi * 300 * t)).astype("<i2").tobytes()


async def run_demo(
    pack_name: str = "pickleball_referee",
    *,
    db_path: str = ":memory:",
    out: Callable[[str], None] = print,
    packs: PackRegistry | None = None,
) -> DemoResult:
    packs = packs or PackRegistry()
    pack = packs.get(pack_name)
    if pack is None:
        raise SystemExit(f"unknown pack {pack_name!r}; available: {', '.join(packs.names())}")
    fx = json.loads((pack.fixtures_dir / "demo.json").read_text())
    cfg = {
        "vision": {"provider": "fake", "fixture": str(pack.fixtures_dir / "vision.json")},
        "asr": {"provider": "fake", "utterances": fx["asr_utterances"]},
    }
    providers = make_all({**make_all_cfg(), **cfg})
    store = MemoryStore(db_path, providers.embedder)
    metrics = Metrics()
    sanitizer = Sanitizer()
    holder: dict[str, Session] = {}

    def frames(stream_id: str, p: Pack, clock: SessionClock) -> AsyncIterator[Frame]:
        async def gen() -> AsyncIterator[Frame]:
            step = int(fx["frame_step_ms"])
            for i, ts in enumerate(range(0, int(fx["duration_ms"]), step)):
                if i and i % p.sampling.batch_frames == 0:
                    await holder["s"].workers[stream_id].drain()  # lossless pacing for the demo
                clock.observe(ts)
                yield Frame(FAKE_JPEG, FrameMeta(stream_id, ts, clock.wall_of(ts), 640, 360))

        return gen()

    deps = SessionDeps(
        providers=providers, packs=packs, store=store, metrics=metrics, frame_source_factory=frames,
        sanitizer=sanitizer, compact_interval_s=3600,
    )  # fmt: skip
    session = Session("00000000-0000-4000-8000-000000000001", deps)
    holder["s"] = session
    res = DemoResult(pack_name, metrics=metrics)

    async def collect() -> None:
        while (m := await session.outbox.get()) is not None:
            res.messages.append(m)

    collector = asyncio.create_task(collect())
    out(f"== argus demo: {pack_name} ({len(fx['streams'])} stream(s), fixture frames, fake providers)")
    await session.handle({"type": "session.start", "scenario": pack_name, "stream_ids": fx["streams"]})
    await session.wait_workers()
    await asyncio.sleep(0)
    await session.compact_once(final=True)
    n_ev = sum(1 for m in res.messages if m["type"] == "event")
    out(f"perception: {n_ev} events, dropped={int(metrics.total('argus_observations_dropped_total'))}, "
        f"sanitized_sentences={sanitizer.removed}")  # fmt: skip

    mark = 0

    async def settle() -> None:
        nonlocal mark
        await session.wait_quiescent()
        while not session.outbox.empty():
            await asyncio.sleep(0)
        await asyncio.sleep(0)
        texts: dict[str, list[str]] = {}
        for m in res.messages[mark:]:
            if m["type"] == "transcript.final":
                res.transcript.append(("you (voice)", m["text"]))
            elif m["type"] == "assistant.text":
                texts.setdefault(m["utterance_id"], []).append(m["delta"])
                if m["final"]:
                    res.transcript.append(("argus", "".join(texts[m["utterance_id"]]).strip()))
        mark = len(res.messages)

    for line in fx["script"]:
        res.transcript.append(("you", line))
        await session.handle({"type": "text.message", "text": line})
        await settle()
    # one spoken turn: silence, a loud burst (-> fake ASR fixture utterance), silence
    seq = 0
    base_ts = session.clock.now_ts_ms()
    silence = b"\x00\x00" * 1600
    for pcm in [silence] * 3 + [_burst(100)] * 8 + [silence] * 6:
        await session.handle(
            {"type": "audio.chunk", "seq": seq, "ts_ms": base_ts + seq * 100, "sample_rate": 16000,
             "pcm16_b64": base64.b64encode(pcm).decode()}
        )  # fmt: skip
        seq += 1
    await settle()

    await session.handle({"type": "control.stop"})
    await collector
    res.events = [m["event"] for m in res.messages if m["type"] == "event"]
    res.state = session.state.snapshot() if session.state else {}
    res.sanitized = sanitizer.removed
    out("-- transcript")
    for role, text in res.transcript:
        out(f"  {role}: {text}")
    if res.state:
        out(f"-- final state: {json.dumps({k: v for k, v in res.state.items() if k in ('game', 'score', 'games_won', 'serving_team')})}")
    audio = sum(1 for m in res.messages if m["type"] == "assistant.audio")
    out(f"-- {len(res.messages)} messages out, {audio} assistant.audio chunks")
    store.close()
    return res


def make_all_cfg() -> dict[str, dict[str, Any]]:
    from argus.providers.registry import load_config

    return load_config(None)

