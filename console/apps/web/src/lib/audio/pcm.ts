/** Pure PCM helpers shared by the capture worklet, the player, and tests. */

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function pcm16ToFloat(input: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = (input[i] ?? 0) / 0x8000;
  return out;
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength); // little-endian hosts only (all browsers)
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToPcm16(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length >> 1; // drop a trailing odd byte
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = (v << 16) >> 16;
  }
  return out;
}

/** Streaming linear-interpolation resampler (mono); keeps fractional position across blocks. */
export class Resampler {
  private carry = new Float32Array(0);
  private pos = 0;
  constructor(
    private inRate: number,
    private outRate: number,
  ) {}

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input;
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);
    const step = this.inRate / this.outRate;
    const out: number[] = [];
    let p = this.pos;
    while (p + 1 < buf.length) {
      const i = Math.floor(p);
      const frac = p - i;
      const x0 = buf[i] ?? 0;
      const x1 = buf[i + 1] ?? 0;
      out.push(x0 + (x1 - x0) * frac);
      p += step;
    }
    const consumed = Math.min(Math.floor(p), buf.length);
    this.carry = buf.slice(consumed);
    this.pos = p - consumed;
    return Float32Array.from(out);
  }
}
