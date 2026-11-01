# Mock gateway

`pnpm dev` (from `host/console`) starts this mock on `http://localhost:8080` plus Vite on :5173.
Run it alone with `pnpm --filter @argus/web mock`. Env: `PORT` (default 8080), `MOCK_TOKEN` (require that bearer / `?token=`).

Implemented: `/healthz`, `/v1/streams` (CRUD; frames are generated PNGs, `ts_ms` shifts the pattern),
`/v1/scenarios` (`home_monitor`, `pickleball_referee`), `/v1/sessions`, and the session WebSocket:
`session.start` -> `session.started` + scripted greeting (text + sine-wave `assistant.audio` with deliberate jitter),
`text.message` -> scripted reply, `audio.chunk` -> `transcript.partial` then (800 ms silence) `transcript.final` + reply,
`control.barge_in` -> `assistant.cancelled`, `history.query` -> `history.result`, an `event` every 4 s
(`rally.start`/`point.won`/`state.snapshot` for pickleball), a `summary` every minute, `stream.status` every 5 s.
Outgoing messages are validated against the real zod schemas. Not implemented: clips, `/v1/history` data, quotas, real auth.
