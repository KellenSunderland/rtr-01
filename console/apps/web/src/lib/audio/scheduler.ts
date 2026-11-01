/**
 * Pure scheduling logic for gapless, jitter-tolerant playback. All times are in AudioContext seconds.
 *
 * Chunks are scheduled back-to-back at `nextTime`. If a chunk arrives late (nextTime already in the
 * past, i.e. underrun / gap) playback resumes at `now + leadSec` so we never schedule in the past, and the
 * underrun counter increments. The first chunk of a burst also gets `leadSec` so small jitter is absorbed.
 */
export interface Scheduled {
  utteranceId: string;
  startAt: number;
  endAt: number;
  id: number;
}

export class PlaybackScheduler {
  private nextTime = 0;
  private items: Scheduled[] = [];
  private cancelled = new Set<string>();
  private seq = 0;
  private lastUtt = "";
  underruns = 0;

  constructor(private leadSec = 0.06) {}

  /** Returns the placement, or null if the utterance was cancelled/flushed (chunk must be dropped). */
  schedule(utteranceId: string, durationSec: number, now: number): Scheduled | null {
    if (this.cancelled.has(utteranceId) || durationSec <= 0) return null;
    this.prune(now);
    let startAt = this.nextTime;
    if (startAt < now + 0.005) {
      // Ran dry mid-utterance (not merely the start of a new one): that is an underrun.
      if (this.nextTime > 0 && this.lastUtt === utteranceId) this.underruns++;
      startAt = now + this.leadSec;
    }
    const it: Scheduled = { utteranceId, startAt, endAt: startAt + durationSec, id: ++this.seq };
    this.nextTime = it.endAt;
    this.lastUtt = utteranceId;
    this.items.push(it);
    return it;
  }

  private prune(now: number) {
    this.items = this.items.filter((i) => i.endAt > now);
  }

  isPlaying(now: number): boolean {
    return this.items.some((i) => i.endAt > now);
  }

  /** Seconds of audio still queued. */
  queuedSec(now: number): number {
    return Math.max(0, this.nextTime - now);
  }

  /** Cancel one utterance: its chunks are removed and later chunks dropped. Returns removed items. */
  cancel(utteranceId: string): Scheduled[] {
    this.cancelled.add(utteranceId);
    const removed = this.items.filter((i) => i.utteranceId === utteranceId);
    this.items = this.items.filter((i) => i.utteranceId !== utteranceId);
    this.recomputeNext();
    return removed;
  }

  /** Local barge-in: drop everything queued and ignore remaining chunks of the utterances heard so far. */
  flush(): Scheduled[] {
    const removed = this.items;
    for (const i of removed) this.cancelled.add(i.utteranceId);
    this.items = [];
    this.nextTime = 0;
    return removed;
  }

  private recomputeNext() {
    this.nextTime = this.items.reduce((m, i) => Math.max(m, i.endAt), 0);
  }

  /** Allow a (new) utterance id again (ids are unique per session so this is only for tests/reset). */
  reset(): void {
    this.items = [];
    this.cancelled.clear();
    this.nextTime = 0;
    this.underruns = 0;
  }
}
