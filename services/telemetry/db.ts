// Local SQLite (WAL) for Phase 3 telemetry, agentic memory and the document-text cache.
// Lives in ~/OpenAFM/runtime/db (outside git). Metadata and short redacted summaries only:
// no raw prompts, full code, command output or credentials.
// Needs `node --experimental-sqlite` on Node 22.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_DB = join(process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM"), "runtime", "db", "openafm.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
  project_hash TEXT, task_type TEXT, complexity_tokens INTEGER,
  policy_version TEXT, policy_hash TEXT, skill TEXT, front_end TEXT,
  status TEXT, outcome_class TEXT, reason_code TEXT, capsule_tokens INTEGER,
  latency_ms INTEGER, human_feedback TEXT
);
CREATE TABLE IF NOT EXISTS routing_decisions (
  decision_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, ts TEXT NOT NULL,
  provider TEXT, candidates TEXT, action TEXT, reason_code TEXT, raw_scores TEXT,
  afm_available INTEGER, risk_signals TEXT
);
CREATE TABLE IF NOT EXISTS model_calls (
  call_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, ts TEXT NOT NULL,
  provider TEXT, model TEXT, purpose TEXT, ok INTEGER, failure TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, cost_type TEXT
);
CREATE TABLE IF NOT EXISTS tool_calls (
  call_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, ts TEXT NOT NULL,
  tool TEXT, ok INTEGER, duration_ms INTEGER, error_type TEXT, result_chars INTEGER
);
CREATE TABLE IF NOT EXISTS verification (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, ts TEXT NOT NULL,
  kind TEXT, passed INTEGER, detail TEXT
);
CREATE TABLE IF NOT EXISTS policy_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, policy_version TEXT, policy_hash TEXT,
  source TEXT, approved_by TEXT, rollback_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_rd_task ON routing_decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_mc_task ON model_calls(task_id);
CREATE INDEX IF NOT EXISTS idx_tc_task ON tool_calls(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks(started_at);

-- Agentic memory (A-MEM / Generative-Agents style notes; see docs/memory.md)
CREATE TABLE IF NOT EXISTS memory_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_hash TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', paths TEXT NOT NULL DEFAULT '',
  importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0, source_task TEXT, links TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mem_project ON memory_notes(project_hash);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, keywords, paths, content='memory_notes', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_notes BEGIN
  INSERT INTO memory_fts(rowid, text, keywords, paths) VALUES (new.id, new.text, new.keywords, new.paths);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_notes BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text, keywords, paths) VALUES ('delete', old.id, old.text, old.keywords, old.paths);
END;

-- Extracted document text, keyed by path + size + mtime (OCR is slow; re-reads are free)
CREATE TABLE IF NOT EXISTS doc_cache (
  key TEXT PRIMARY KEY, path TEXT NOT NULL, extracted_at TEXT NOT NULL, json TEXT NOT NULL
);
`;

let shared: DatabaseSync | undefined;

export function openDb(path = DEFAULT_DB): DatabaseSync {
  if (path === DEFAULT_DB && shared) return shared;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  // Holds document summaries and task history: owner-only, like the token file.
  if (path !== ":memory:") for (const f of [path, `${path}-wal`, `${path}-shm`]) { try { chmodSync(f, 0o600); } catch { /* not created yet */ } }
  if (path === DEFAULT_DB) shared = db;
  return db;
}

export const now = () => new Date().toISOString();
