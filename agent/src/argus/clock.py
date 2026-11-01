"""Session clock: maps the gateway's monotonic ``ts_ms`` to wall time via an offset captured from the
first stamped message (``offset = wall_now - ts_ms``). Used only to stamp wall_ms on agent-created records;
the gateway-supplied ``ts_ms`` is never recomputed from wall time."""

from __future__ import annotations

import time
from collections.abc import Callable


class SessionClock:
    def __init__(self, wall_fn: Callable[[], int] | None = None) -> None:
        self._wall = wall_fn or (lambda: int(time.time() * 1000))
        self.start_wall_ms = self._wall()
        self.offset_ms = self.start_wall_ms  # wall = offset + ts (until calibrated)
        self._calibrated = False
        self.latest_ts_ms = 0

    def observe(self, ts_ms: int) -> None:
        """Record a gateway-stamped ts_ms (calibrates the offset on first use)."""
        if not self._calibrated:
            self.offset_ms = self._wall() - ts_ms
            self._calibrated = True
        self.latest_ts_ms = max(self.latest_ts_ms, ts_ms)

    def wall_of(self, ts_ms: int) -> int:
        return self.offset_ms + ts_ms

    def now_wall_ms(self) -> int:
        # never behind data we have already stamped (matters for fixture/virtual-time replays)
        return max(self._wall(), self.offset_ms + self.latest_ts_ms)

    def now_ts_ms(self) -> int:
        return max(self.latest_ts_ms, self._wall() - self.offset_ms, 0)
