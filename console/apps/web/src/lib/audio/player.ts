import type { z } from "zod";
import type { AssistantAudio } from "@argus/protocol";
import { base64ToPcm16, pcm16ToFloat } from "./pcm";
import { PlaybackScheduler } from "./scheduler";

type AudioMsg = z.infer<typeof AssistantAudio>;

/** Web Audio player for `assistant.audio` chunks. */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private sched = new PlaybackScheduler();
  private sources = new Map<number, { src: AudioBufferSourceNode; utt: string }>();
  /** Utterance whose first chunk is still pending cancellation bookkeeping. */
  private lastSeq = new Map<string, number>();

  private ensure(): AudioContext {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  get isPlaying(): boolean {
    return this.ctx ? this.sched.isPlaying(this.ctx.currentTime) : false;
  }
  get underruns(): number {
    return this.sched.underruns;
  }

  enqueue(msg: AudioMsg): void {
    const ctx = this.ensure();
    // Drop duplicate / reordered chunks within an utterance.
    const prev = this.lastSeq.get(msg.utterance_id);
    if (prev !== undefined && msg.seq <= prev) return;
    this.lastSeq.set(msg.utterance_id, msg.seq);
    const pcm = base64ToPcm16(msg.pcm16_b64);
    if (pcm.length === 0) return;
    const dur = pcm.length / msg.sample_rate;
    const slot = this.sched.schedule(msg.utterance_id, dur, ctx.currentTime);
    if (!slot) return;
    const buf = ctx.createBuffer(1, pcm.length, msg.sample_rate);
    buf.copyToChannel(pcm16ToFloat(pcm), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => this.sources.delete(slot.id);
    this.sources.set(slot.id, { src, utt: msg.utterance_id });
    src.start(slot.startAt);
  }

  private stopAll(ids: number[]) {
    for (const id of ids) {
      const s = this.sources.get(id);
      if (!s) continue;
      try {
        s.src.stop();
      } catch {
        /* already stopped */
      }
      this.sources.delete(id);
    }
  }

  /** `assistant.cancelled`: clear any remaining queued audio for the utterance. */
  cancel(utteranceId: string): void {
    this.stopAll(this.sched.cancel(utteranceId).map((i) => i.id));
  }

  /** Local barge-in. */
  flush(): void {
    this.stopAll(this.sched.flush().map((i) => i.id));
  }

  async dispose(): Promise<void> {
    this.flush();
    await this.ctx?.close();
    this.ctx = null;
  }
}
