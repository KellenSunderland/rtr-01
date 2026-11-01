"""PCM16 resampling + VAD.

Uses ``libmediacore`` through ctypes (VAD + resample only), loaded lazily from the path in env
``ARGUS_MEDIACORE_LIB``. When the variable is unset or the library cannot be loaded, a pure
Python/numpy implementation with the same semantics is used.
"""

from __future__ import annotations

import ctypes
import logging
import math
import os
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

log = logging.getLogger(__name__)

MC_OK = 0
VAD_NONE, VAD_SPEECH_START, VAD_SPEECH_END = 0, 1, 2


class _VadConfig(ctypes.Structure):
    _fields_ = [  # noqa: RUF012
        ("sample_rate", ctypes.c_int32),
        ("frame_ms", ctypes.c_int32),
        ("threshold_dbfs", ctypes.c_double),
        ("min_speech_ms", ctypes.c_int32),
        ("hangover_ms", ctypes.c_int32),
    ]


@lru_cache(maxsize=1)
def _lib() -> ctypes.CDLL | None:
    path = os.environ.get("ARGUS_MEDIACORE_LIB")
    if not path:
        return None
    try:
        lib = ctypes.CDLL(path)
        i16p = ctypes.POINTER(ctypes.c_int16)
        lib.mc_resample_pcm16.argtypes = [
            i16p, ctypes.c_size_t, ctypes.c_int32, ctypes.c_int32, i16p, ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]  # fmt: skip
        lib.mc_resample_pcm16.restype = ctypes.c_int
        lib.mc_vad_create.argtypes = [ctypes.POINTER(_VadConfig), ctypes.POINTER(ctypes.c_void_p)]
        lib.mc_vad_create.restype = ctypes.c_int
        lib.mc_vad_destroy.argtypes = [ctypes.c_void_p]
        lib.mc_vad_destroy.restype = None
        lib.mc_vad_process.argtypes = [
            ctypes.c_void_p, i16p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int32),
        ]  # fmt: skip
        lib.mc_vad_process.restype = ctypes.c_int
        lib.mc_vad_reset.argtypes = [ctypes.c_void_p]
        lib.mc_vad_reset.restype = None
        return lib
    except (OSError, AttributeError) as e:
        log.warning("mediacore unavailable, using pure-python audio fallback: %s", e)
        return None


def using_mediacore() -> bool:
    return _lib() is not None


def pcm_to_np(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2")


def resample_pcm16(pcm: bytes, in_rate: int, out_rate: int) -> bytes:
    """Linear-interpolation resample of mono PCM16 LE bytes."""
    if in_rate == out_rate or not pcm:
        return pcm
    x = np.ascontiguousarray(pcm_to_np(pcm).astype(np.int16))
    n_out = math.ceil(len(x) * out_rate / in_rate)
    lib = _lib()
    if lib is not None:
        out = np.zeros(n_out + 1, dtype=np.int16)
        got = ctypes.c_size_t(0)
        st = lib.mc_resample_pcm16(
            x.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)), len(x), in_rate, out_rate,
            out.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)), len(out), ctypes.byref(got),
        )  # fmt: skip
        if st == MC_OK:
            return out[: got.value].astype("<i2").tobytes()
        log.warning("mc_resample_pcm16 failed (%d); falling back", st)
    if len(x) == 1:
        return np.repeat(x, n_out).astype("<i2").tobytes()
    pos = np.arange(n_out) * (in_rate / out_rate)
    pos = np.minimum(pos, len(x) - 1)
    y = np.interp(pos, np.arange(len(x)), x.astype(np.float64))
    return np.clip(np.rint(y), -32768, 32767).astype("<i2").tobytes()


@dataclass(slots=True)
class VadConfig:
    sample_rate: int = 16000
    frame_ms: int = 20
    threshold_dbfs: float = -40.0
    min_speech_ms: int = 100
    hangover_ms: int = 300


def rms_dbfs(x: np.ndarray) -> float:
    if len(x) == 0:
        return -120.0
    r = float(np.sqrt(np.mean((x.astype(np.float64) / 32768.0) ** 2)))
    return -120.0 if r <= 1e-6 else max(-120.0, 20 * math.log10(r))


class Vad:
    """Energy VAD. ``process`` returns the list of transitions (``VAD_SPEECH_START``/``END``) in the chunk
    (the C API reports only the first transition per call, so we feed it frame-sized slices)."""

    def __init__(self, cfg: VadConfig | None = None) -> None:
        self.cfg = cfg or VadConfig()
        self.frame = self.cfg.sample_rate * self.cfg.frame_ms // 1000
        self.in_speech = False
        self._handle = ctypes.c_void_p()
        self._lib = _lib()
        self._buf = np.zeros(0, dtype=np.int16)
        self._speech_ms = 0
        self._silence_ms = 0
        if self._lib is not None:
            c = _VadConfig(
                self.cfg.sample_rate, self.cfg.frame_ms, self.cfg.threshold_dbfs,
                self.cfg.min_speech_ms, self.cfg.hangover_ms,
            )  # fmt: skip
            if self._lib.mc_vad_create(ctypes.byref(c), ctypes.byref(self._handle)) != MC_OK:
                self._lib = None

    def close(self) -> None:
        if self._lib is not None and self._handle:
            self._lib.mc_vad_destroy(self._handle)
            self._handle = ctypes.c_void_p()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:  # noqa: BLE001
            pass

    def reset(self) -> None:
        self.in_speech = False
        self._buf = np.zeros(0, dtype=np.int16)
        self._speech_ms = self._silence_ms = 0
        if self._lib is not None:
            self._lib.mc_vad_reset(self._handle)

    def process(self, pcm: bytes) -> list[int]:
        events: list[int] = []
        x = np.concatenate([self._buf, pcm_to_np(pcm)]).astype(np.int16)
        n_full = len(x) // self.frame * self.frame
        self._buf = x[n_full:]
        for i in range(0, n_full, self.frame):
            ev = self._frame(np.ascontiguousarray(x[i : i + self.frame]))
            if ev != VAD_NONE:
                events.append(ev)
        return events

    def _frame(self, fr: np.ndarray) -> int:
        if self._lib is not None:
            ev = ctypes.c_int(0)
            ins = ctypes.c_int32(0)
            self._lib.mc_vad_process(
                self._handle, fr.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)), len(fr),
                ctypes.byref(ev), ctypes.byref(ins),
            )  # fmt: skip
            self.in_speech = bool(ins.value)
            return ev.value
        loud = rms_dbfs(fr) > self.cfg.threshold_dbfs
        ms = self.cfg.frame_ms
        if not self.in_speech:
            self._speech_ms = self._speech_ms + ms if loud else 0
            if self._speech_ms >= self.cfg.min_speech_ms:
                self.in_speech, self._silence_ms = True, 0
                return VAD_SPEECH_START
        else:
            self._silence_ms = 0 if loud else self._silence_ms + ms
            if self._silence_ms >= self.cfg.hangover_ms:
                self.in_speech, self._speech_ms = False, 0
                return VAD_SPEECH_END
        return VAD_NONE
