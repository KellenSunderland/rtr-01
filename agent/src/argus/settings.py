"""Process configuration from environment variables."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field


@dataclass(slots=True)
class Settings:
    providers_path: str | None = None
    db_path: str = "memory.db"
    gateway_url: str | None = None  # e.g. ws://127.0.0.1:8080 ; None = no perception workers
    internal_token: str | None = None
    retention_s: int = 3600
    packs_dir: str | None = None
    log_level: str = "INFO"
    extra: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> Settings:
        e = os.environ
        return cls(
            providers_path=e.get("ARGUS_PROVIDERS") or None,
            db_path=e.get("ARGUS_DB", "memory.db"),
            gateway_url=e.get("ARGUS_GATEWAY_URL") or None,
            internal_token=e.get("ARGUS_INTERNAL_TOKEN") or None,
            retention_s=int(e.get("ARGUS_RETENTION_S", "3600")),
            packs_dir=e.get("ARGUS_PACKS_DIR") or None,
            log_level=e.get("ARGUS_LOG_LEVEL", "INFO"),
        )


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        d = {
            "ts": round(time.time(), 3),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for k, v in getattr(record, "__dict__", {}).items():
            if k.startswith("x_"):
                d[k[2:]] = v
        if record.exc_info:
            d["exc"] = self.formatException(record.exc_info)
        return json.dumps(d, default=str)


def setup_logging(level: str = "INFO") -> None:
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [h]
    root.setLevel(level.upper())
