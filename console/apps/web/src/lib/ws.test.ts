import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArgusSocket, type WebSocketLike } from "./ws";

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  // helpers
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(d: unknown) {
    this.onmessage?.({ data: typeof d === "string" ? d : JSON.stringify(d) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const started = { type: "session.started", session_id: uuid, scenario: "s", streams: [], server_wall_ms: 1 };

function mk() {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const s = new ArgusSocket({
    url: "ws://x",
    scenario: "s",
    streamIds: ["cam1"],
    WebSocketImpl: FakeWS,
    backoff: { baseMs: 100, maxMs: 1000, factor: 2, jitter: 0 },
    setTimeoutImpl: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeoutImpl: () => {},
  });
  return { s, timers };
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("ArgusSocket", () => {
  it("sends session.start first on open", () => {
    const { s } = mk();
    s.connect();
    FakeWS.instances[0]!.open();
    const m = JSON.parse(FakeWS.instances[0]!.sent[0]!);
    expect(m).toMatchObject({ type: "session.start", scenario: "s", stream_ids: ["cam1"], locale: "en-US" });
  });

  it("emits valid messages and drops invalid ones without throwing", () => {
    const { s } = mk();
    const got: unknown[] = [];
    const bad: string[] = [];
    s.on("message", (m) => got.push(m));
    s.on("invalid", (i) => bad.push(i.reason));
    s.connect();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.recv(started);
    ws.recv("not json{");
    ws.recv({ type: "nope" });
    ws.recv({ type: "transcript.partial", text: 5, ts_ms: 1 });
    ws.onmessage?.({ data: new ArrayBuffer(4) });
    ws.recv({ type: "transcript.partial", text: "hi", ts_ms: 1 });
    expect(got).toHaveLength(2);
    expect(bad).toHaveLength(4);
  });

  it("refuses to send invalid or offline messages", () => {
    const { s } = mk();
    s.connect();
    const ws = FakeWS.instances[0]!;
    expect(s.send({ type: "control.barge_in" })).toBe(false); // not open yet
    ws.open();
    expect(s.send({ type: "control.barge_in" })).toBe(true);
    expect(s.send({ type: "text.message", text: "" })).toBe(false);
    expect(ws.sent).toHaveLength(2); // session.start + barge_in
  });

  it("reconnects with exponential backoff and a fresh session.start", () => {
    const { s, timers } = mk();
    const delays: number[] = [];
    s.on("reconnecting", (r) => delays.push(r.delayMs));
    s.connect();
    FakeWS.instances[0]!.open();
    FakeWS.instances[0]!.drop();
    expect(s.status).toBe("reconnecting");
    timers.shift()!.fn();
    FakeWS.instances[1]!.drop(); // fails before session.started: backoff keeps growing
    timers.shift()!.fn();
    FakeWS.instances[2]!.drop();
    expect(delays).toEqual([100, 200, 400]);
    timers.shift()!.fn();
    const ws = FakeWS.instances[3]!;
    ws.open();
    expect(JSON.parse(ws.sent[0]!).type).toBe("session.start");
    ws.recv(started); // success resets backoff
    ws.drop();
    expect(delays.at(-1)).toBe(100);
  });

  it("caps delay at maxMs", () => {
    const { s, timers } = mk();
    const delays: number[] = [];
    s.on("reconnecting", (r) => delays.push(r.delayMs));
    s.connect();
    for (let i = 0; i < 6; i++) {
      FakeWS.instances[i]!.drop();
      timers.shift()!.fn();
    }
    expect(Math.max(...delays)).toBe(1000);
  });

  it("does not reconnect after close()", () => {
    const { s, timers } = mk();
    s.connect();
    FakeWS.instances[0]!.open();
    s.close();
    expect(s.status).toBe("closed");
    expect(timers).toHaveLength(0);
  });

  it("ignores events from a stale socket", () => {
    const { s, timers } = mk();
    const got: unknown[] = [];
    s.on("message", (m) => got.push(m));
    s.connect();
    const old = FakeWS.instances[0]!;
    old.drop();
    timers.shift()!.fn();
    old.recv(started);
    expect(got).toHaveLength(0);
  });
});
