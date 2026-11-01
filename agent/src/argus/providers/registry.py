"""Provider registry: ``make_provider(kind, cfg)`` and ``providers.yaml`` loading.

Providers register ``(kind, name) -> factory(cfg)`` via :func:`register` (the stub/fake modules do
this on import) or via the ``argus.providers`` entry-point group (entry point value is a module to
import, which is expected to call :func:`register`).
"""

from __future__ import annotations

import importlib
import importlib.metadata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from argus.providers.base import (
    ASR,
    TTS,
    ChatModel,
    Detector,
    Embedder,
    ProviderKind,
    ProviderUnavailable,
    VisionModel,
)

Factory = Callable[[dict[str, Any]], Any]
KINDS: tuple[ProviderKind, ...] = ("chat", "vision", "detector", "embedder", "asr", "tts")
_BUILTIN_MODULES = (
    "argus.providers.fake",
    "argus.providers.anthropic",
    "argus.providers.openai",
    "argus.providers.ollama",
    "argus.providers.local",
)
_FACTORIES: dict[tuple[str, str], Factory] = {}
_loaded = False


def register(kind: str, name: str, factory: Factory) -> None:
    _FACTORIES[(kind, name)] = factory


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    for mod in _BUILTIN_MODULES:
        importlib.import_module(mod)
    for ep in importlib.metadata.entry_points(group="argus.providers"):
        importlib.import_module(ep.value)


def available() -> dict[str, list[str]]:
    _ensure_loaded()
    out: dict[str, list[str]] = {k: [] for k in KINDS}
    for kind, name in sorted(_FACTORIES):
        out.setdefault(kind, []).append(name)
    return out


def make_provider(kind: str, cfg: dict[str, Any] | None = None) -> Any:
    """Build a provider. ``cfg['provider']`` selects the implementation (default ``fake``)."""
    _ensure_loaded()
    if kind not in KINDS:
        raise ValueError(f"unknown provider kind {kind!r}")
    cfg = dict(cfg or {})
    name = cfg.pop("provider", "fake")
    factory = _FACTORIES.get((kind, name))
    if factory is None:
        raise ProviderUnavailable(f"no {kind} provider named {name!r}", provider=str(name))
    return factory(cfg)


@dataclass(slots=True)
class Providers:
    chat: ChatModel
    vision: VisionModel
    detector: Detector
    embedder: Embedder
    asr: ASR
    tts: TTS


def load_config(path: str | Path | None) -> dict[str, dict[str, Any]]:
    """Read providers.yaml; missing path or sections default to ``{provider: fake}``."""
    raw: dict[str, Any] = {}
    if path:
        raw = yaml.safe_load(Path(path).read_text()) or {}
        if not isinstance(raw, dict):
            raise ValueError("providers.yaml must be a mapping")
    return {k: dict(raw.get(k) or {"provider": "fake"}) for k in KINDS}


def make_all(config: dict[str, dict[str, Any]] | None = None) -> Providers:
    config = config or load_config(None)
    return Providers(**{k: make_provider(k, config.get(k)) for k in KINDS})
