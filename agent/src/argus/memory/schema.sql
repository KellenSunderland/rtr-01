-- Argus agent memory: the 1-hour rolling history and its vector index.
-- SQLite (WAL) + sqlite-vec. One DB per agent process (memory.db).
-- Retention: rows older than `retention_s` (default 3600) measured on wall_ms are
-- deleted by the compactor's retention job; the vec0 table is kept in sync by
-- deleting the same rowids.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,                 -- uuid
  scenario      TEXT NOT NULL,
  created_wall_ms INTEGER NOT NULL,
  closed_wall_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  rowid         INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,             -- uuid, protocol SceneEvent.id
  stream_id     TEXT NOT NULL,
  scenario      TEXT NOT NULL,
  ts_ms         INTEGER NOT NULL,                 -- session clock
  wall_ms       INTEGER NOT NULL,                 -- unix epoch ms (retention + cross-session queries)
  type          TEXT NOT NULL,
  confidence    REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  summary       TEXT NOT NULL,
  actors_json   TEXT NOT NULL DEFAULT '[]',
  attrs_json    TEXT NOT NULL DEFAULT '{}',
  frame_stream  TEXT,
  frame_ts_ms   INTEGER,
  embedded      INTEGER NOT NULL DEFAULT 0        -- 1 once a vector exists in events_vec
);
CREATE INDEX IF NOT EXISTS events_stream_wall ON events(stream_id, wall_ms);
CREATE INDEX IF NOT EXISTS events_type_wall   ON events(type, wall_ms);

-- Vector index. dim is fixed at DB creation from the Embedder (stored in meta);
-- a different embedder dim requires a rebuild (documented, not auto).
-- CREATE VIRTUAL TABLE events_vec USING vec0(embedding float[<dim>]);   -- created at runtime with the real dim
-- rowid of events_vec == events.rowid

CREATE TABLE IF NOT EXISTS minute_summaries (
  rowid           INTEGER PRIMARY KEY,
  stream_id       TEXT NOT NULL,
  minute_start_ms INTEGER NOT NULL,               -- session clock, aligned to 60_000
  wall_ms         INTEGER NOT NULL,
  text            TEXT NOT NULL,
  event_count     INTEGER NOT NULL,
  embedded        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (stream_id, minute_start_ms)
);
-- CREATE VIRTUAL TABLE summaries_vec USING vec0(embedding float[<dim>]);

CREATE TABLE IF NOT EXISTS transcripts (
  rowid         INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  utterance_id  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user','assistant')),
  ts_ms         INTEGER NOT NULL,
  wall_ms       INTEGER NOT NULL,
  text          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: schema_version, embedder_name, embedder_dim, retention_s
