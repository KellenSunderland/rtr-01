/**
 * Mock Argus gateway for `pnpm dev` without the real backend.
 *   pnpm --filter @argus/web mock            (PORT=8080 by default; MOCK_TOKEN=... to require a token)
 * Implements: /healthz, /v1/streams (CRUD + fake PNG frames), /v1/scenarios, /v1/sessions, session WS.
 * Outgoing WS messages are validated against the real zod protocol.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessage, ServerMessage, type StreamInfo } from "../../../packages/protocol/src/index";

const PORT = Number(process.env.PORT ?? 8080);
const REQUIRED_TOKEN = process.env.MOCK_TOKEN;

const streams = new Map<string, StreamInfo>([
  ["demo", { id: "demo", name: "Demo camera", uri: "device:0", state: "live", fps: 5 }],
  ["court", { id: "court", name: "Court", uri: "device:1", state: "live", fps: 10 }],
]);
const sessions = new Map<
  string,
  { id: string; scenario: string; stream_ids: string[]; created_wall_ms: number; state: "open" | "closed" }
>();

const SCENARIOS = [
  {
    name: "home_monitor",
    description: "Watches rooms/doors",
    event_types: [
      { type: "dog.eating", description: "A dog is eating." },
      { type: "person.entered", description: "Someone came in." },
    ],
    tools: ["search_history", "what_happened", "describe_now"],
  },
  {
    name: "pickleball_referee",
    description: "Keeps score at a pickleball court",
    event_types: [
      { type: "rally.start", description: "A rally begins." },
      { type: "point.won", description: "A point is won (attrs.team)." },
      { type: "state.snapshot", description: "Pack state." },
    ],
    tools: ["current_score"],
  },
];

// ---------------------------------------------------------------- fake PNG
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 160x90 RGB PNG: moving gradient keyed by `t` so polling visibly changes. */
function fakePng(t: number): Buffer {
  const w = 160,
    h = 90;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = (x * 2 + t) & 255;
      raw[o + 1] = (y * 3 + t / 2) & 255;
      raw[o + 2] = Math.abs(((x + y + t) % 120) - 60) * 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- HTTP
function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "X-Frame-Ts-Ms, X-Frame-Wall-Ms");
}
function json(res: ServerResponse, status: number, body: unknown) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const err = (res: ServerResponse, status: number, code: string, message: string) =>
  json(res, status, { code, message });
function authorized(req: IncomingMessage, url: URL): boolean {
  if (!REQUIRED_TOKEN) return true;
  const h = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return (h ?? url.searchParams.get("token")) === REQUIRED_TOKEN;
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 64 * 1024) throw new Error("too large");
  }
  return s ? JSON.parse(s) : {};
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    cors(res);
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (path === "/healthz") return void res.writeHead(200).end("ok");
    if (!authorized(req, url)) return err(res, 401, "unauthorized", "bad token");
    try {
      if (path === "/v1/scenarios") return json(res, 200, SCENARIOS);
      if (path === "/v1/streams" && req.method === "GET") return json(res, 200, [...streams.values()]);
      if (path === "/v1/streams" && req.method === "POST") {
        const b = (await readBody(req)) as { id?: string; name?: string; uri?: string };
        if (!b.id || !/^[a-z0-9][a-z0-9_-]*$/.test(b.id) || b.id.length > 64 || !b.uri)
          return err(res, 400, "bad_request", "invalid stream");
        if (streams.has(b.id)) return err(res, 409, "bad_request", "exists");
        const s: StreamInfo = { id: b.id, name: b.name ?? b.id, uri: b.uri, state: "live", fps: 5 };
        streams.set(s.id, s);
        return json(res, 201, s);
      }
      let m = /^\/v1\/streams\/([^/]+)(\/frame)?$/.exec(path);
      if (m) {
        const s = streams.get(decodeURIComponent(m[1]!));
        if (!s) return err(res, 404, "not_found", "no such stream");
        if (m[2]) {
          const ts = url.searchParams.get("ts_ms");
          const t = ts !== null ? Number(ts) / 40 : Date.now() / 40;
          const png = fakePng(Math.floor(t));
          res.writeHead(200, {
            "Content-Type": "image/png",
            "X-Frame-Ts-Ms": ts ?? "0",
            "X-Frame-Wall-Ms": String(Date.now()),
          });
          return void res.end(png);
        }
        if (req.method === "DELETE") {
          streams.delete(s.id);
          return void res.writeHead(204).end();
        }
        return json(res, 200, s);
      }
      if (path === "/v1/sessions" && req.method === "POST") {
        const b = (await readBody(req)) as { scenario?: string; stream_ids?: string[] };
        if (!b.scenario || !Array.isArray(b.stream_ids) || b.stream_ids.length === 0)
          return err(res, 400, "bad_request", "invalid session");
        const s = {
          id: randomUUID(),
          scenario: b.scenario,
          stream_ids: b.stream_ids,
          created_wall_ms: Date.now(),
          state: "open" as const,
        };
        sessions.set(s.id, s);
        return json(res, 201, s);
      }
      m = /^\/v1\/sessions\/([^/]+)$/.exec(path);
      if (m) {
        const s = sessions.get(m[1]!);
        if (!s) return err(res, 404, "not_found", "no such session");
        if (req.method === "DELETE") {
          sessions.delete(s.id);
          return void res.writeHead(204).end();
        }
        return json(res, 200, s);
      }
      if (path === "/v1/history") return json(res, 200, { events: [], summaries: [], truncated: false });
      err(res, 404, "not_found", "unknown route");
    } catch (e) {
      err(res, 400, "bad_request", String(e));
    }
  })();
});

// ---------------------------------------------------------------- WS
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const m = /^\/v1\/sessions\/([^/]+)\/ws$/.exec(url.pathname);
  if (!m || !sessions.has(m[1]!) || !authorized(req, url)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return void socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleSession(ws, sessions.get(m[1]!)!));
});

function sinePcmB64(freq: number, ms: number, rate: number, phase0: number): string {
  const n = Math.round((rate * ms) / 1000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++)
    pcm[i] = Math.round(Math.sin(2 * Math.PI * freq * ((phase0 + i) / rate)) * 6000);
  return Buffer.from(pcm.buffer).toString("base64");
}

function handleSession(ws: WebSocket, sess: { id: string; scenario: string; stream_ids: string[] }) {
  let startMono = 0;
  let started = false;
  let utt = 0;
  let speaking: { id: string; timers: NodeJS.Timeout[] } | null = null;
  const events: unknown[] = [];
  let audioIdleTimer: NodeJS.Timeout | undefined;
  let heardAudio = false;
  const now = () => Math.round(performance.now() - startMono);
  const send = (msg: unknown) => {
    const r = ServerMessage.safeParse(msg);
    if (!r.success) return void console.error("mock produced invalid message", r.error.issues[0], msg);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(r.data));
  };

  const cancelSpeaking = (reason: "barge_in" | "stop") => {
    if (!speaking) return;
    speaking.timers.forEach(clearTimeout);
    send({ type: "assistant.cancelled", utterance_id: speaking.id, reason });
    speaking = null;
  };
  const speak = (reply: string) => {
    cancelSpeaking("barge_in");
    const id = `u-${++utt}`;
    const timers: NodeJS.Timeout[] = [];
    speaking = { id, timers };
    const words = reply.split(" ");
    words.forEach((w, i) =>
      timers.push(
        setTimeout(
          () =>
            send({
              type: "assistant.text",
              utterance_id: id,
              delta: (i ? " " : "") + w,
              final: i === words.length - 1,
            }),
          150 * i,
        ),
      ),
    );
    const chunks = Math.max(6, words.length * 3);
    for (let i = 0; i < chunks; i++) {
      // Jitter on purpose: some chunks arrive late.
      const delay = i * 100 + (i % 7 === 6 ? 120 : 0);
      timers.push(
        setTimeout(() => {
          send({
            type: "assistant.audio",
            utterance_id: id,
            seq: i,
            ts_ms: now(),
            sample_rate: 24000,
            pcm16_b64: sinePcmB64(300 + 40 * (i % 5), 100, 24000, i * 2400),
          });
          if (i === chunks - 1) speaking = null;
        }, delay),
      );
    }
  };

  const emitEvent = (type: string, attrs: Record<string, unknown>, summary: string) => {
    const ev = {
      id: randomUUID(),
      stream_id: sess.stream_ids[0] ?? "demo",
      ts_ms: now(),
      wall_ms: Date.now(),
      type,
      confidence: 0.8,
      actors: [],
      attrs,
      summary,
      scenario: sess.scenario,
    };
    events.push(ev);
    if (events.length > 500) events.shift();
    send({ type: "event", event: ev });
    return ev;
  };

  let tick = 0;
  let scores = { a: 0, b: 0 };
  const periodic = setInterval(() => {
    if (!started) return;
    tick++;
    if (sess.scenario === "pickleball_referee") {
      if (tick % 2 === 1) emitEvent("rally.start", {}, "Rally started");
      else {
        const team = Math.random() < 0.5 ? "a" : "b";
        scores = { ...scores, [team]: scores[team] + 1 };
        emitEvent("point.won", { team }, `Point to team ${team}`);
        emitEvent(
          "state.snapshot",
          { score: `${scores.a}-${scores.b}`, server: team, side: tick % 4 === 0 ? "left" : "right" },
          "State snapshot",
        );
      }
    } else {
      emitEvent(
        tick % 3 === 0 ? "person.entered" : "dog.eating",
        { bowl_location: "kitchen" },
        tick % 3 === 0 ? "Someone walked in" : "The dog is eating",
      );
    }
    if (tick % 15 === 0) {
      send({
        type: "summary",
        summary: {
          stream_id: sess.stream_ids[0] ?? "demo",
          minute_start_ms: Math.floor(now() / 60000) * 60000,
          wall_ms: Date.now(),
          text: "Quiet minute with a few events.",
          event_count: 3,
        },
      });
    }
  }, 4000);
  const status = setInterval(() => {
    const s = streams.get(sess.stream_ids[0] ?? "");
    if (started && s) send({ type: "stream.status", stream: { ...s, fps: 4 + Math.random() * 2 } });
  }, 5000);

  ws.on("message", (data, isBinary) => {
    if (isBinary || (data as Buffer).length > 64 * 1024) return void ws.close(1009, "too large");
    let parsed;
    try {
      parsed = ClientMessage.safeParse(JSON.parse(data.toString()));
    } catch {
      return void send({ type: "error", code: "bad_request", message: "invalid JSON" });
    }
    if (!parsed.success) return void send({ type: "error", code: "bad_request", message: "invalid message" });
    const m = parsed.data;
    if (!started && m.type !== "session.start")
      return void send({
        type: "error",
        code: "bad_request",
        message: "first message must be session.start",
      });
    switch (m.type) {
      case "session.start":
        started = true;
        startMono = performance.now();
        send({
          type: "session.started",
          session_id: sess.id,
          scenario: m.scenario,
          streams: m.stream_ids.map(
            (id) => streams.get(id) ?? { id, name: id, uri: "", state: "stopped" as const },
          ),
          server_wall_ms: Date.now(),
        });
        setTimeout(() => speak("Hello, I am Argus. I can see your streams. Ask me anything."), 500);
        break;
      case "text.message":
        speak(`You said ${m.text.slice(0, 60)}. Nothing unusual is happening right now.`);
        break;
      case "audio.chunk": {
        if (!heardAudio) send({ type: "transcript.partial", text: "listening", ts_ms: m.ts_ms });
        heardAudio = true;
        clearTimeout(audioIdleTimer);
        audioIdleTimer = setTimeout(() => {
          heardAudio = false;
          const id = `u-${++utt}`;
          send({
            type: "transcript.final",
            text: "(mock transcription of your speech)",
            ts_ms: now(),
            utterance_id: id,
          });
          speak("I heard you. This is a scripted mock reply.");
        }, 800);
        break;
      }
      case "control.barge_in":
        cancelSpeaking("barge_in");
        break;
      case "control.stop":
        cancelSpeaking("stop");
        break;
      case "history.query":
        send({
          type: "history.result",
          request_id: m.request_id,
          events: events.filter(
            (e) =>
              (e as { ts_ms: number }).ts_ms >= m.since_ms && (e as { ts_ms: number }).ts_ms < m.until_ms,
          ),
          summaries: [],
          truncated: false,
        });
        break;
    }
  });
  ws.on("close", () => {
    clearInterval(periodic);
    clearInterval(status);
    clearTimeout(audioIdleTimer);
    speaking?.timers.forEach(clearTimeout);
  });
}

server.listen(PORT, () =>
  console.log(`mock gateway on http://localhost:${PORT}${REQUIRED_TOKEN ? " (token required)" : ""}`),
);
