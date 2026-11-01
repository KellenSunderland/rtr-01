import asyncio
import math

import numpy as np
import pytest

from argus.providers import registry
from argus.providers.base import (
    ChatMessage,
    Done,
    Frame,
    FrameMeta,
    ProviderUnavailable,
    TextDelta,
    ToolCallEvent,
    ToolSpec,
)
from argus.providers.fake import FakeASR, FakeChatModel, FakeEmbedder, FakeTTS, FakeVisionModel


def test_registry_defaults_and_stubs():
    p = registry.make_all()
    assert p.chat.name == "fake-chat" and p.embedder.dim == 64
    avail = registry.available()
    for k in registry.KINDS:
        assert "fake" in avail[k]
        for stub in ("anthropic", "openai", "ollama", "local"):
            assert stub in avail[k]
    with pytest.raises(ProviderUnavailable, match="not implemented"):
        registry.make_provider("chat", {"provider": "anthropic"})
    with pytest.raises(ProviderUnavailable):
        registry.make_provider("chat", {"provider": "nope"})
    with pytest.raises(ValueError):
        registry.make_provider("bogus", {})


def test_load_config(tmp_path):
    f = tmp_path / "providers.yaml"
    f.write_text("chat: {provider: fake, responses: [hi]}\nembedder: {provider: fake, dim: 16}\n")
    cfg = registry.load_config(f)
    assert cfg["vision"] == {"provider": "fake"}
    p = registry.make_all(cfg)
    assert p.embedder.dim == 16


async def collect(agen):
    return [x async for x in agen]


async def test_fake_chat_rules():
    chat = FakeChatModel()
    tools = [ToolSpec("search_history", "", {}), ToolSpec("what_happened", "", {})]
    ev = await collect(
        chat.complete([ChatMessage("user", "what happened in the last 3 minutes")], tools=tools)
    )
    calls = [e for e in ev if isinstance(e, ToolCallEvent)]
    assert calls[0].call.name == "what_happened" and calls[0].call.arguments["minutes_back"] == 3
    assert isinstance(ev[-1], Done) and ev[-1].stop_reason == "tool_use"
    ev = await collect(chat.complete([ChatMessage("user", "when did the dog eat")], tools=tools))
    assert [e for e in ev if isinstance(e, ToolCallEvent)][0].call.name == "search_history"
    from argus.providers.base import ToolResult

    ev = await collect(
        chat.complete([ChatMessage("user", "x"), ChatMessage("tool", tool_result=ToolResult("c", "RESULT"))])
    )
    assert "RESULT" in "".join(e.text for e in ev if isinstance(e, TextDelta))
    ev = await collect(chat.complete([ChatMessage("user", "hello")]))
    assert "".join(e.text for e in ev if isinstance(e, TextDelta)) == "You said: hello"
    scripted = FakeChatModel(["one", "two"])
    t = lambda evs: "".join(e.text for e in evs if isinstance(e, TextDelta))
    assert t(await collect(scripted.complete([ChatMessage("user", "a")]))) == "one"
    assert t(await collect(scripted.complete([ChatMessage("user", "a")]))) == "two"


async def test_fake_vision_window():
    v = FakeVisionModel(
        [{"stream_id": "s", "from_ms": 100, "to_ms": 200, "event_type": "a.b", "summary": "x"}]
    )
    f = lambda sid, ts: Frame(b"", FrameMeta(sid, ts, ts, 1, 1))
    assert await v.observe([f("s", 50), f("other", 150)], system_prompt="", event_types=["a.b"]) == []
    got = await v.observe([f("s", 50), f("s", 150)], system_prompt="", event_types=["a.b"])
    assert len(got) == 1 and got[0].frame_index == 1
    assert await v.observe([f("s", 150)], system_prompt="", event_types=["a.b"]) == []  # once only


async def test_fake_embedder_deterministic_unit():
    e = FakeEmbedder()
    a, b = await e.embed(["dog eating", "dog eating"])
    assert a == b and len(a) == 64
    assert math.isclose(sum(x * x for x in a), 1.0, abs_tol=1e-9)
    (c,) = await e.embed(["car driving fast"])
    assert sum(x * y for x, y in zip(a, c, strict=True)) < 0.5


async def test_fake_asr_bursts():
    asr = FakeASR(["hello there general kenobi", "second"])
    loud = (np.full(1600, 8000, dtype="<i2")).tobytes()
    quiet = bytes(3200)

    async def audio(chunks):
        for c in chunks:
            yield c

    out = await collect(asr.transcribe(audio([quiet, loud, loud, loud, quiet]), sample_rate=16000))
    assert not out[0].final and out[-1].final and out[-1].text == "hello there general kenobi"
    assert await collect(asr.transcribe(audio([quiet, quiet]), sample_rate=16000)) == []
    out = await collect(asr.transcribe(audio([loud]), sample_rate=16000))
    assert out[-1].text == "second"


async def test_fake_tts_duration_and_cancel():
    tts = FakeTTS()
    short = b"".join(await collect(tts.synthesize("hi")))
    long_ = b"".join(await collect(tts.synthesize("a" * 50)))
    assert len(long_) > len(short) and len(short) == int(0.2 * 16000) * 2
    x = np.frombuffer(long_, dtype="<i2").astype(float)
    spec = np.abs(np.fft.rfft(x))
    assert abs(np.argmax(spec) * 16000 / len(x) - 440) < 5
    got = 0

    async def consume():
        nonlocal got
        async for _ in FakeTTS(realtime=True).synthesize("a" * 100):
            got += 1

    t = asyncio.create_task(consume())
    await asyncio.sleep(0.25)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert 0 < got < 10
