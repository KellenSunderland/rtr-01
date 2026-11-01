import workletUrl from "./capture.worklet.ts?worker&url";
import { pcm16ToBase64 } from "./pcm";

export interface MicCallbacks {
  /** One 100 ms chunk of 16 kHz mono PCM16, already base64-encoded. */
  onChunk(pcm16_b64: string): void;
}

/** Push-to-talk microphone capture. start() on press, stop() on release. */
export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;

  constructor(private cb: MicCallbacks) {}

  get active(): boolean {
    return this.node !== null;
  }

  async start(): Promise<void> {
    if (this.node) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext(); // native rate; the worklet resamples to 16 kHz
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "argus-capture");
    this.node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => this.cb.onChunk(pcm16ToBase64(new Int16Array(ev.data)));
    this.src.connect(this.node); // not connected to destination: no echo of the mic
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.src?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const ctx = this.ctx;
    this.node = this.src = this.stream = this.ctx = null;
    await ctx?.close();
  }
}
