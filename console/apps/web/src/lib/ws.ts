import { ClientMessage, ServerMessage } from "@argus/protocol";
import type { ServerMessage as ServerMsg, ClientMessage as ClientMsg } from "@argus/protocol";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from "./backoff";
import { Emitter } from "./emitter";

/** Subset of the WebSocket API we rely on (lets tests inject a fake). */
export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export const WS_OPEN = 1;
/** Gateway limit for text frames (CONTRACTS.md). */
export const MAX_TEXT_BYTES = 64 * 1024;

export type SocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface SocketEvents extends Record<string, unknown> {
  message: ServerMsg;
  status: SocketStatus;
  /** Fired for each (re)connection once `session.start` has been sent. */
  started: { attempt: number };
  invalid: { reason: string; raw: unknown };
  reconnecting: { attempt: number; delayMs: number };
}

export interface ArgusSocketOptions {
  url: string | (() => string);
  scenario: string;
  streamIds: string[];
  locale?: string;
  WebSocketImpl?: WebSocketCtor;
  backoff?: BackoffOptions;
  /** Max reconnect attempts before giving up (default: unlimited). */
  maxAttempts?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
  rand?: () => number;
}

export class ArgusSocket extends Emitter<SocketEvents> {
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private manuallyClosed = false;
  private _status: SocketStatus = "idle";
  private o: ArgusSocketOptions;

  constructor(options: ArgusSocketOptions) {
    super();
    this.o = options;
  }

  get status(): SocketStatus {
    return this._status;
  }

  private setStatus(s: SocketStatus) {
    if (this._status !== s) {
      this._status = s;
      this.emit("status", s);
    }
  }

  connect(): void {
    this.manuallyClosed = false;
    this.open();
  }

  private open(): void {
    const Ctor = this.o.WebSocketImpl ?? (WebSocket as unknown as WebSocketCtor);
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocketLike;
    try {
      ws = new Ctor(typeof this.o.url === "function" ? this.o.url() : this.o.url);
    } catch (e) {
      console.error("ws construct failed", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.setStatus("open");
      // Resume = a fresh session.start on every connection; the first message must be session.start.
      this.sendRaw({
        type: "session.start",
        scenario: this.o.scenario,
        stream_ids: this.o.streamIds,
        locale: this.o.locale ?? "en-US",
      });
      this.emit("started", { attempt: this.attempt });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const msg = this.parse(ev.data);
      if (!msg) return;
      if (msg.type === "session.started") this.attempt = 0; // healthy connection: reset backoff
      this.emit("message", msg);
    };
    ws.onerror = () => {
      /* followed by onclose */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.manuallyClosed) this.setStatus("closed");
      else this.scheduleReconnect();
    };
  }

  /** Validate an incoming frame. Never throws: invalid frames are logged, reported and dropped. */
  private parse(data: unknown): ServerMsg | null {
    if (typeof data !== "string") {
      this.drop("non-text frame", data);
      return null;
    }
    if (data.length > MAX_TEXT_BYTES * 4) {
      this.drop("oversized frame", data.slice(0, 100));
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.drop("invalid JSON", data.slice(0, 200));
      return null;
    }
    const r = ServerMessage.safeParse(json);
    if (!r.success) {
      this.drop(r.error.issues[0] ? `${r.error.issues[0].path.join(".")}: ${r.error.issues[0].message}` : "schema", json);
      return null;
    }
    return r.data;
  }

  private drop(reason: string, raw: unknown) {
    console.warn("[ws] dropped invalid server message:", reason);
    this.emit("invalid", { reason, raw });
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed) return;
    if (this.o.maxAttempts !== undefined && this.attempt >= this.o.maxAttempts) {
      this.setStatus("closed");
      return;
    }
    const delayMs = backoffDelay(this.attempt, this.o.backoff ?? DEFAULT_BACKOFF, this.o.rand);
    this.attempt++;
    this.setStatus("reconnecting");
    this.emit("reconnecting", { attempt: this.attempt, delayMs });
    const st = this.o.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = st(() => {
      this.timer = null;
      this.open();
    }, delayMs);
  }

  private sendRaw(msg: unknown): boolean {
    const r = ClientMessage.safeParse(msg);
    if (!r.success) {
      console.warn("[ws] refusing to send invalid client message", r.error.issues[0]);
      return false;
    }
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    const text = JSON.stringify(r.data);
    if (text.length > MAX_TEXT_BYTES) return false;
    this.ws.send(text);
    return true;
  }

  /** Returns false (and drops the message) if offline or invalid. */
  send(msg: ClientMsg | Record<string, unknown>): boolean {
    return this.sendRaw(msg);
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.timer !== null) (this.o.clearTimeoutImpl ?? ((h) => clearTimeout(h as number)))(this.timer);
    this.timer = null;
    const ws = this.ws;
    if (ws) {
      try {
        ws.close(1000, "client close");
      } catch {
        /* ignore */
      }
      // Fake sockets may not fire onclose; settle state now.
      this.ws = null;
    }
    this.setStatus("closed");
  }
}
