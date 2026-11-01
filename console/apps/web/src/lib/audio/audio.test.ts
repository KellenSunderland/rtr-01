import { describe, expect, it } from "vitest";
import { PlaybackScheduler } from "./scheduler";
import { Resampler, base64ToPcm16, floatToPcm16, pcm16ToBase64, pcm16ToFloat } from "./pcm";

describe("PlaybackScheduler", () => {
  it("schedules the first chunk with lead and the rest back-to-back", () => {
    const s = new PlaybackScheduler(0.05);
    const a = s.schedule("u-1", 0.1, 10)!;
    const b = s.schedule("u-1", 0.1, 10.01)!;
    const c = s.schedule("u-1", 0.2, 10.02)!;
    expect(a.startAt).toBeCloseTo(10.05);
    expect(b.startAt).toBeCloseTo(a.endAt);
    expect(c.startAt).toBeCloseTo(b.endAt);
    expect(s.queuedSec(10.02)).toBeCloseTo(0.43, 5);
  });

  it("handles gaps: late chunk restarts at now+lead and counts an underrun", () => {
    const s = new PlaybackScheduler(0.05);
    s.schedule("u-1", 0.1, 10);
    expect(s.isPlaying(10.1)).toBe(true);
    const late = s.schedule("u-1", 0.1, 11)!; // 0.85 s after the previous chunk ended
    expect(late.startAt).toBeCloseTo(11.05);
    expect(s.underruns).toBe(1);
  });

  it("never schedules in the past", () => {
    const s = new PlaybackScheduler(0.05);
    for (let t = 0; t < 5; t += 0.5) expect(s.schedule("u", 0.1, t)!.startAt).toBeGreaterThan(t);
  });

  it("cancel removes the utterance, drops later chunks, keeps others", () => {
    const s = new PlaybackScheduler(0.05);
    const a = s.schedule("u-1", 0.5, 0)!;
    const b = s.schedule("u-2", 0.5, 0)!;
    const removed = s.cancel("u-1");
    expect(removed.map((r) => r.id)).toEqual([a.id]);
    expect(s.schedule("u-1", 0.1, 0.1)).toBeNull();
    expect(s.isPlaying(0.2)).toBe(true);
    expect(b.utteranceId).toBe("u-2");
  });

  it("flush clears everything and blocks stragglers of flushed utterances", () => {
    const s = new PlaybackScheduler();
    s.schedule("u-1", 1, 0);
    s.schedule("u-1", 1, 0);
    expect(s.flush()).toHaveLength(2);
    expect(s.isPlaying(0.1)).toBe(false);
    expect(s.schedule("u-1", 1, 0.2)).toBeNull();
    expect(s.schedule("u-2", 1, 0.2)).not.toBeNull();
  });

  it("ignores empty chunks", () => {
    expect(new PlaybackScheduler().schedule("u", 0, 0)).toBeNull();
  });
});

describe("pcm helpers", () => {
  it("roundtrips base64 PCM16", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    expect(Array.from(base64ToPcm16(pcm16ToBase64(pcm)))).toEqual(Array.from(pcm));
  });
  it("clips floats to int16 range", () => {
    expect(Array.from(floatToPcm16(Float32Array.from([2, -2, 0, 0.5])))).toEqual([32767, -32768, 0, 16384]);
    expect(pcm16ToFloat(Int16Array.from([-32768]))[0]).toBe(-1);
  });
  it("resamples 48k -> 16k to ~1/3 the samples across blocks", () => {
    const r = new Resampler(48000, 16000);
    let total = 0;
    for (let i = 0; i < 10; i++) total += r.process(new Float32Array(128).fill(0.5)).length;
    expect(Math.abs(total - 1280 / 3)).toBeLessThanOrEqual(2);
  });
  it("preserves a DC signal and passes through at equal rates", () => {
    const out = new Resampler(44100, 16000).process(new Float32Array(441).fill(0.25));
    expect(out.length).toBeGreaterThan(100);
    expect(out.every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
    const same = new Float32Array(4);
    expect(new Resampler(16000, 16000).process(same)).toBe(same);
  });
});
