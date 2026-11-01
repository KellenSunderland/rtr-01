"""Stub `local` provider: registered so config errors are explicit; not implemented yet."""

from __future__ import annotations

from typing import Any

from argus.providers.base import (  # noqa: F401  (Protocols re-exported for implementers)
    ASR,
    TTS,
    ChatModel,
    Detector,
    Embedder,
    ProviderKind,
    ProviderUnavailable,
    VisionModel,
)
from argus.providers.registry import KINDS, register

NAME = "local"


def _factory(_cfg: dict[str, Any]) -> Any:
    raise ProviderUnavailable("not implemented", provider=NAME)


for _kind in KINDS:
    register(_kind, NAME, _factory)
