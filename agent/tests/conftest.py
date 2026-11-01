from __future__ import annotations

import asyncio
import base64
import time
from collections.abc import AsyncIterator

import pytest

from argus.conversation.session import Session, SessionDeps
from argus.memory.store import MemoryStore
from argus.providers.base import Frame, FrameMeta
from argus.providers.registry import make_all
from argus.scenarios.registry import PackRegistry

WALL0 = int(time.time() * 1000) - 10_000
SID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def providers():
    return make_all()


@pytest.fixture
def store(providers):
    s = MemoryStore(":memory:", providers.embedder)
    yield s
    s.close()


@pytest.fixture(scope="session")
def packs():
    return PackRegistry()


def make_session(providers, store, packs, **kw) -> Session:
    deps = SessionDeps(providers=providers, packs=packs, store=store, compact_interval_s=3600, **kw)
    return Session(SID, deps)


async def drain(session: Session, until_type: str | None = None, timeout: float = 5.0) -> list[dict]:
    """Collect outbox messages until quiescent (or until a message of ``until_type``)."""
    out: list[dict] = []
    async with asyncio.timeout(timeout):
        while True:
            m = await session.outbox.get()
            if m is None:
                return out
            out.append(m)
            if until_type and m["type"] == until_type:
                return out


def pcm_b64(pcm: bytes) -> str:
    return base64.b64encode(pcm).decode()


async def frames_of(stream_id: str, stamps: list[int]) -> AsyncIterator[Frame]:
    for ts in stamps:
        yield Frame(b"\xff\xd8\xff\xd9", FrameMeta(stream_id, ts, WALL0 + ts, 640, 360))
