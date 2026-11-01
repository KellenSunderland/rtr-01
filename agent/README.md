# Argus agent

Python 3.13 service of Argus: perception (frames -> scene events), memory (SQLite + sqlite-vec, 1 h
history), and conversation (ASR -> chat with tools -> TTS, with barge-in). Everything runs offline with
deterministic fakes. Contracts live in `../CONTRACTS.md`.

## Run

```sh
export PATH=$HOME/.local/bin:$PATH
uv sync
uv run argus demo                      # full session against pack fixtures, no gateway
uv run argus demo --pack home_monitor
uv run argus packs list
uv run argus serve --port 8090         # internal WS + REST; binds 127.0.0.1
uv run pytest && uv run ruff check . && uv run ruff format --check . && uv run ty check
```

`serve` exposes `/internal/sessions/{id}/ws` (gateway is the client), `GET /v1/scenarios`,
`GET /v1/history?since_ms&until_ms[&stream_id&q&limit]` (wall-clock epoch ms), `/healthz`, `/metrics`.
Auth: `X-Internal-Token` header or `?token=` when `ARGUS_INTERNAL_TOKEN` is set; a non-loopback bind
without a token is refused.

## Configuration (env)

| Variable | Meaning |
|---|---|
| `ARGUS_PROVIDERS` | path to `providers.yaml` (default: all fakes) |
| `ARGUS_DB` | memory DB path (default `memory.db`) |
| `ARGUS_GATEWAY_URL` | e.g. `ws://127.0.0.1:8080`; perception workers dial `/internal/frames/{stream}` |
| `ARGUS_INTERNAL_TOKEN` | shared secret for internal endpoints (sent to the gateway as `X-Internal-Token`) |
| `ARGUS_RETENTION_S` | history retention, default 3600 |
| `ARGUS_PACKS_DIR` | extra directory of scenario packs |
| `ARGUS_MEDIACORE_LIB` | path to `libmediacore`; used via ctypes for VAD + resample. Unset/unloadable -> pure-Python fallback |

`providers.yaml`:

```yaml
chat:     {provider: fake, responses: ["Hello"], token_delay_s: 0.0}
vision:   {provider: fake, fixture: path/to/vision.json}
detector: {provider: fake}
embedder: {provider: fake, dim: 64}
asr:      {provider: fake, utterances: ["what happened in the last minute"]}
tts:      {provider: fake, realtime: false}
```
`anthropic`, `openai`, `ollama`, `local` are registered stubs that raise `ProviderUnavailable("not implemented")`.
Add real providers by calling `argus.providers.registry.register(kind, name, factory)` (or the
`argus.providers` entry-point group pointing at a module that does).

## Pack authoring quickstart

Create `<packs dir>/<name>/pack.yaml` (see `src/argus/scenarios/PACK_FORMAT.md`; the directory name must equal
`name`). Minimum: `name`, `event_types`, `prompts.vision_system`, `prompts.chat_system`. Optionally add
`state.py` (`class State(ScenarioState)` with `apply(event)` / `snapshot()`; if it has an integer
`scoring_version` that increases on scoring changes and the taxonomy declares `state.snapshot`, the core
emits a derived `state.snapshot` event with `attrs = snapshot()`), `tools.py` (`TOOLS = [ScenarioTool(...)]`,
async handlers `(ctx, **args)`), and `fixtures/vision.json` (`{"timeline": [{stream_id, from_ms, to_ms,
event_type, summary, attrs, confidence}]}`) + `fixtures/demo.json` (frame step/duration/streams/script) to make
`argus demo --pack <name>` work. Run `uv run argus packs list`: invalid packs are reported on stderr.

## Notes / design choices

* History windows are half-open `[since_ms, until_ms)` on **wall_ms**; `ts_ms` stays the originating session clock.
* The user's spoken `transcript.final.utterance_id` is the id of the assistant reply it triggers.
* Per-utterance ordering: one task emits an utterance's messages; barge-in cancels and awaits it before
  enqueuing `assistant.cancelled`, so that message is always last for the utterance.
* Transcript text is never logged at INFO.
