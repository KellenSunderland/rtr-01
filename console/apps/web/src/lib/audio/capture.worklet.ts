/// <reference lib="webworker" />
// AudioWorklet global scope: not covered by the DOM lib, so declare what we use.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

import { Resampler, floatToPcm16 } from "./pcm";

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms @ 16 kHz = 3200 bytes (well under the 64 KiB frame limit)

class CaptureProcessor extends AudioWorkletProcessor {
  private resampler = new Resampler(sampleRate, TARGET_RATE);
  private pending = new Int16Array(CHUNK_SAMPLES);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const pcm = floatToPcm16(this.resampler.process(ch));
    let off = 0;
    while (off < pcm.length) {
      const n = Math.min(pcm.length - off, CHUNK_SAMPLES - this.filled);
      this.pending.set(pcm.subarray(off, off + n), this.filled);
      this.filled += n;
      off += n;
      if (this.filled === CHUNK_SAMPLES) {
        const out = this.pending;
        this.pending = new Int16Array(CHUNK_SAMPLES);
        this.filled = 0;
        this.port.postMessage(out.buffer, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("argus-capture", CaptureProcessor as unknown as new () => AudioWorkletProcessor);
