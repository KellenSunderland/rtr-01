import numpy as np

from argus.audio import VAD_SPEECH_END, VAD_SPEECH_START, Vad, resample_pcm16, using_mediacore


def tone(ms, rate=16000, amp=0.5):
    t = np.arange(rate * ms // 1000) / rate
    return (amp * 32767 * np.sin(2 * np.pi * 300 * t)).astype("<i2").tobytes()


def test_fallback_in_use_without_env():
    assert not using_mediacore()


def test_resample_lengths_and_identity():
    pcm = tone(100, 48000)
    assert len(resample_pcm16(pcm, 48000, 16000)) // 2 == 1600
    assert len(resample_pcm16(tone(100, 24000), 24000, 16000)) // 2 == 1600
    assert resample_pcm16(pcm, 16000, 16000) == pcm and resample_pcm16(b"", 8000, 16000) == b""


def test_vad_transitions():
    v = Vad()
    ev = v.process(bytes(3200) + tone(200) + bytes(2 * 16000 // 2))
    assert ev == [VAD_SPEECH_START, VAD_SPEECH_END]
    assert not v.in_speech
    assert v.process(bytes(3200)) == []
