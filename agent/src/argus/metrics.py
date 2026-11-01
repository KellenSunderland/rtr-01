"""Tiny in-process Prometheus-text metrics registry (counters and gauges)."""

from __future__ import annotations

import threading
from collections import defaultdict

LabelKey = tuple[tuple[str, str], ...]


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[str, dict[LabelKey, float]] = defaultdict(dict)
        self._gauges: dict[str, dict[LabelKey, float]] = defaultdict(dict)
        self._help: dict[str, str] = {}

    @staticmethod
    def _key(labels: dict[str, str]) -> LabelKey:
        return tuple(sorted(labels.items()))

    def inc(self, name: str, amount: float = 1.0, **labels: str) -> None:
        with self._lock:
            d = self._counters[name]
            k = self._key(labels)
            d[k] = d.get(k, 0.0) + amount

    def set(self, name: str, value: float, **labels: str) -> None:
        with self._lock:
            self._gauges[name][self._key(labels)] = value

    def get(self, name: str, **labels: str) -> float:
        with self._lock:
            k = self._key(labels)
            return self._counters.get(name, {}).get(k, self._gauges.get(name, {}).get(k, 0.0))

    def total(self, name: str) -> float:
        with self._lock:
            return sum(self._counters.get(name, {}).values())

    def render(self) -> str:
        lines: list[str] = []
        with self._lock:
            for kind, store in (("counter", self._counters), ("gauge", self._gauges)):
                for name in sorted(store):
                    lines.append(f"# TYPE {name} {kind}")
                    for k, v in sorted(store[name].items()):
                        lab = ",".join(f'{a}="{_esc(b)}"' for a, b in k)
                        lines.append(f"{name}{{{lab}}} {v}" if lab else f"{name} {v}")
        return "\n".join(lines) + "\n"


def _esc(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
