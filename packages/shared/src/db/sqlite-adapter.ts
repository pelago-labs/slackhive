/**
 * @fileoverview SQLite adapter implementation using better-sqlite3.
 *
 * Translates PostgreSQL-style SQL ($1, $2, ... params) to SQLite (?, ?, ...)
 * and handles type differences (arrays → JSON, JSONB → TEXT, UUIDs → TEXT).
 *
 * @module @slackhive/shared/db/sqlite-adapter
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import type { DbAdapter, DbResult, DbRow } from './adapter';

// =============================================================================
// SQL Translation
// =============================================================================

/**
 * Converts PostgreSQL $N params to SQLite ? params.
 * Handles repeated references to the same $N by duplicating the param value.
 *
 * @example
 *   translateParams('SELECT * FROM t WHERE a = $1 AND b = $2', ['x', 'y'])
 *   // → { sql: 'SELECT * FROM t WHERE a = ? AND b = ?', params: ['x', 'y'] }
 *
 *   translateParams('INSERT INTO t (v) VALUES (encrypt($1, $2)) ON CONFLICT DO UPDATE SET v = encrypt($1, $2)', ['val', 'key'])
 *   // → { sql: 'INSERT INTO t (v) VALUES (encrypt(?, ?)) ON CONFLICT DO UPDATE SET v = encrypt(?, ?)', params: ['val', 'key', 'val', 'key'] }
 */
function translateParams(sql: string, params?: unknown[]): { sql: string; params: unknown[] } {
  if (!params || params.length === 0) {
    return { sql, params: [] };
  }

  const outParams: unknown[] = [];
  const translated = sql.replace(/\$(\d+)/g, (_match, numStr) => {
    const idx = parseInt(numStr, 10) - 1; // $1 → index 0
    outParams.push(params[idx]);
    return '?';
  });

  return { sql: translated, params: outParams };
}

/**
 * Applies SQLite-specific SQL transformations:
 * - now() → datetime('now')
 * - gen_random_uuid() → handled in JS (pre-generate UUID)
 * - ILIKE → LIKE (SQLite LIKE is case-insensitive for ASCII)
 * - TEXT[] columns are stored as JSON TEXT
 * - UUID[] columns are stored as JSON TEXT
 * - ::text, ::bytea type casts → removed
 * - pgp_sym_encrypt/decrypt → handled at the application layer
 */
function translateSql(sql: string): string {
  let out = sql;

  // Remove Postgres type casts
  out = out.replace(/::text/g, '');
  out = out.replace(/::bytea/g, '');

  // now() → datetime('now')
  out = out.replace(/\bnow\(\)/gi, "datetime('now')");

  // ILIKE → LIKE
  out = out.replace(/\bILIKE\b/gi, 'LIKE');

  // Boolean literals: true/false → 1/0
  out = out.replace(/\b= true\b/gi, '= 1');
  out = out.replace(/\b= false\b/gi, '= 0');

  // Remove COALESCE wrapping for simple cases — SQLite supports COALESCE natively

  return out;
}

// =============================================================================
// Column names with array types (stored as JSON in SQLite)
// =============================================================================

const ARRAY_COLUMNS = new Set([
  'reports_to',
  'tags',
  'allowed_tools',
  'denied_tools',
  'allowed_channels',
  'mcp_ids',
]);

const JSON_COLUMNS = new Set([
  'config',
  'skills_json',
]);

/**
 * Serialize array/JSON params before writing to SQLite.
 * Arrays become JSON strings, objects become JSON strings.
 */
function serializeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object' && !(value instanceof Buffer)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Deserialize a row from SQLite, parsing JSON columns back to arrays/objects.
 */
function deserializeRow(row: Record<string, unknown>): DbRow {
  const out: DbRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (ARRAY_COLUMNS.has(key) && typeof value === 'string') {
      try { out[key] = JSON.parse(value); } catch { out[key] = []; }
    } else if (JSON_COLUMNS.has(key) && typeof value === 'string') {
      try { out[key] = JSON.parse(value); } catch { out[key] = value; }
    } else if (key === 'enabled' || key === 'is_boss' || key === 'verbose') {
      // SQLite stores booleans as 0/1
      out[key] = value === 1 || value === true;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// =============================================================================
// SQLite Adapter
// =============================================================================

class SqliteAdapter implements DbAdapter {
  readonly type = 'sqlite' as const;

  constructor(private db: Database.Database) {}

  async query(sql: string, params?: unknown[]): Promise<DbResult> {
    // Translate PostgreSQL → SQLite
    let translatedSql = translateSql(sql);
    const translated = translateParams(translatedSql, params);
    translatedSql = translated.sql;
    const sqliteParams = translated.params.map(serializeParam);

    // Determine if this is a read or write operation. Both leading SELECT and
    // WITH (CTE-prefixed reads) are routed to .all(); other statements run via
    // .run() unless they include RETURNING.
    const trimmed = translatedSql.trim().toUpperCase();
    const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');
    const hasReturning = /\bRETURNING\b/i.test(translatedSql);

    if (isSelect) {
      const rows = this.db.prepare(translatedSql).all(...sqliteParams) as Record<string, unknown>[];
      return {
        rows: rows.map(deserializeRow),
        rowCount: rows.length,
      };
    }

    if (hasReturning) {
      // SQLite supports RETURNING since 3.35 (2021-03-12)
      // better-sqlite3 supports it via .all() on INSERT/UPDATE/DELETE
      const rows = this.db.prepare(translatedSql).all(...sqliteParams) as Record<string, unknown>[];
      return {
        rows: rows.map(deserializeRow),
        rowCount: rows.length,
      };
    }

    // Regular write (INSERT/UPDATE/DELETE without RETURNING)
    const info = this.db.prepare(translatedSql).run(...sqliteParams);
    return {
      rows: [],
      rowCount: info.changes,
    };
  }

  async transaction<T>(fn: (client: DbAdapter) => Promise<T>): Promise<T> {
    // better-sqlite3 transactions are synchronous, but our interface is async.
    // We run the whole callback inside a BEGIN/COMMIT block manually.
    this.db.prepare('BEGIN').run();
    try {
      const result = await fn(this);
      this.db.prepare('COMMIT').run();
      return result;
    } catch (err) {
      this.db.prepare('ROLLBACK').run();
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// =============================================================================
// Schema initialization
// =============================================================================

const SQLITE_SCHEMA = `
-- SlackHive SQLite Schema
-- Mirrors the PostgreSQL schema with SQLite-compatible types.
-- Arrays are stored as JSON TEXT. UUIDs are TEXT. Timestamps are TEXT (ISO 8601).

CREATE TABLE IF NOT EXISTS agents (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT UNIQUE NOT NULL,
  name                 TEXT NOT NULL,
  persona              TEXT,
  description          TEXT,
  model                TEXT NOT NULL DEFAULT 'claude-opus-4-6',
  status               TEXT NOT NULL DEFAULT 'stopped'
                                     CHECK (status IN ('running', 'stopped', 'error')),
  enabled              INTEGER NOT NULL DEFAULT 1,
  is_boss              INTEGER NOT NULL DEFAULT 0,
  verbose              INTEGER NOT NULL DEFAULT 1,
  sensitivity_check    TEXT NOT NULL DEFAULT 'deterministic'
                                     CHECK (sensitivity_check IN ('off','deterministic','smart')),
  enforcement_redaction INTEGER NOT NULL DEFAULT 0,
  redaction_level      TEXT NOT NULL DEFAULT 'secrets'
                                     CHECK (redaction_level IN ('secrets','pii','all')),
  sensitivity_guidance TEXT NOT NULL DEFAULT '',
  reports_to           TEXT NOT NULL DEFAULT '[]',
  claude_md            TEXT NOT NULL DEFAULT '',
  created_by           TEXT NOT NULL DEFAULT 'system',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_error           TEXT,
  runner_id            TEXT,
  last_heartbeat       TEXT
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                    TEXT PRIMARY KEY,
  name                  TEXT UNIQUE NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'stdio'
                             CHECK (type IN ('stdio', 'sse', 'http')),
  config                TEXT NOT NULL,
  description           TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_by            TEXT NOT NULL DEFAULT 'admin',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  tool_list_cache       TEXT,         -- JSON: [{name, description?}, ...]
  tool_list_cached_at   TEXT          -- ISO timestamp of last successful fetch
);

CREATE TABLE IF NOT EXISTS agent_mcps (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_id   TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, mcp_id)
);

CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  filename    TEXT NOT NULL,
  content     TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agent_id, category, filename)
);

CREATE TABLE IF NOT EXISTS permissions (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE UNIQUE,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  denied_tools  TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  name           TEXT NOT NULL,
  content        TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,  -- "remember always" tier
  scope_user_id  TEXT,                        -- slack_user_id; null = global
  scope_group_id TEXT,                        -- agent_groups.id; null = global
  created_by     TEXT,                        -- provenance: user id whose conversation produced it
  source         TEXT,                        -- 'agent' | 'reflection' | 'manual'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agent_id, name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_key       TEXT NOT NULL,
  claude_session_id TEXT,
  mcp_hash          TEXT,
  last_activity     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agent_id, session_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer'
                     CHECK (role IN ('admin', 'editor', 'viewer')),
  slack_user_id TEXT UNIQUE,
  slack_email   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  cron_schedule TEXT NOT NULL,
  target_type   TEXT NOT NULL DEFAULT 'channel'
                     CHECK (target_type IN ('channel', 'dm')),
  target_id     TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  -- Optional plain-English condition. When set, the runner injects it plus a
  -- NO_UPDATE sentinel instruction; if the agent decides the condition holds it
  -- replies NO_UPDATE and the run posts nothing. NULL/empty → always post.
  skip_when     TEXT,
  created_by    TEXT NOT NULL DEFAULT 'system',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'success', 'error')),
  output      TEXT,
  error       TEXT,
  -- 0 when the run completed but was intentionally not posted (skip_when matched).
  posted      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agent_access (
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_write    INTEGER NOT NULL DEFAULT 1,
  access_level TEXT NOT NULL DEFAULT 'edit',
  PRIMARY KEY (agent_id, user_id)
);

CREATE TABLE IF NOT EXISTS agent_groups (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  priority     INTEGER NOT NULL DEFAULT 100,
  verbose      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agent_id, name),
  UNIQUE (agent_id, priority)
);

CREATE TABLE IF NOT EXISTS agent_group_members (
  group_id   TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS agent_snapshots (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label            TEXT,
  trigger          TEXT NOT NULL
                        CHECK (trigger IN ('manual', 'skill_change', 'tools_change', 'mcp_change', 'restrictions', 'skills', 'permissions', 'mcps', 'claude-md')),
  created_by       TEXT NOT NULL,
  skills_json      TEXT NOT NULL DEFAULT '[]',
  allowed_tools    TEXT NOT NULL DEFAULT '[]',
  denied_tools     TEXT NOT NULL DEFAULT '[]',
  mcp_ids          TEXT NOT NULL DEFAULT '[]',
  compiled_md      TEXT NOT NULL DEFAULT '',
  allowed_channels TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS env_vars (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  created_by  TEXT NOT NULL DEFAULT 'admin',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_restrictions (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE UNIQUE,
  allowed_channels TEXT NOT NULL DEFAULT '[]',
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_integrations (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL CHECK (platform IN ('slack','discord','telegram','whatsapp','teams')),
  credentials TEXT NOT NULL,
  bot_user_id TEXT,
  bot_handle  TEXT,
  bot_image_url TEXT,
  app_id      TEXT,
  app_credentials TEXT,
  enabled     INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, platform)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  platform            TEXT NOT NULL DEFAULT 'slack',
  channel_id          TEXT NOT NULL,
  thread_ts           TEXT NOT NULL,
  initiator_user_id   TEXT,
  initiator_handle    TEXT,
  initial_agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
  summary             TEXT,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at    TEXT NOT NULL DEFAULT (datetime('now')),
  activity_count      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(platform, channel_id, thread_ts)
);

CREATE TABLE IF NOT EXISTS activities (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id               TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform               TEXT NOT NULL DEFAULT 'slack',
  initiator_kind         TEXT NOT NULL CHECK (initiator_kind IN ('user','agent')),
  initiator_user_id      TEXT,
  initiator_handle       TEXT,
  message_ref            TEXT,
  message_preview        TEXT,
  reply_ts               TEXT,
  started_at             TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at            TEXT,
  status                 TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','done','error')),
  error                  TEXT,
  tool_call_count        INTEGER NOT NULL DEFAULT 0,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  cache_read_tokens      INTEGER,
  cache_creation_tokens  INTEGER,
  -- Model actually in effect when this turn ran. Stamped at begin so the
  -- token-by-model breakdown survives later model switches (grouping by the
  -- agent's CURRENT model would retroactively relabel history).
  model                  TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY,
  activity_id     TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  args_preview    TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','ok','error')),
  result_preview  TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('url', 'file', 'repo')),
  name        TEXT NOT NULL,
  url         TEXT,
  repo_url    TEXT,
  branch      TEXT DEFAULT 'main',
  pat_env_ref TEXT,
  sync_cron   TEXT,
  content     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'compiled', 'stale', 'error')),
  word_count  INTEGER DEFAULT 0,
  last_synced TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Wiki Folders (platform-level knowledge library) ─────────────────────────

CREATE TABLE IF NOT EXISTS wiki_folders (
  id          TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  created_by  TEXT NOT NULL DEFAULT 'system',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wiki_sources (
  id              TEXT PRIMARY KEY,
  folder_id       TEXT NOT NULL REFERENCES wiki_folders(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('url', 'file', 'repo')),
  name            TEXT NOT NULL,
  content         TEXT,
  url             TEXT,
  repo_url        TEXT,
  branch          TEXT DEFAULT 'main',
  pat_env_ref     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'building', 'compiled', 'stale', 'error')),
  word_count      INTEGER DEFAULT 0,
  last_synced     TEXT,
  -- Last commit SHA on the configured branch that was successfully ingested.
  -- NULL until the first successful repo sync. Used for diff-aware re-syncs:
  -- on the next build the runner clones HEAD, compares HEAD SHA to
  -- last_synced_sha, and only feeds Claude the changed files (saving ~95%
  -- of the prompt budget on small diffs). When NULL or unreachable, the
  -- runner falls back to the full snapshot ingest.
  last_synced_sha TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (folder_id, name)
);

CREATE TABLE IF NOT EXISTS agent_wiki_folders (
  agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES wiki_folders(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, folder_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_knowledge_agent ON knowledge_sources(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_agent_name ON knowledge_sources(agent_id, name);

-- Other indexes
CREATE INDEX IF NOT EXISTS idx_sessions_agent_key      ON sessions(agent_id, session_key);
CREATE INDEX IF NOT EXISTS idx_sessions_activity       ON sessions(last_activity);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_activity ON sessions(agent_id, last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_skills_agent_order      ON skills(agent_id, category, sort_order);
CREATE INDEX IF NOT EXISTS idx_memories_agent_type     ON memories(agent_id, type);
CREATE INDEX IF NOT EXISTS idx_memories_agent_name     ON memories(agent_id, name);
CREATE INDEX IF NOT EXISTS idx_agent_mcps_agent        ON agent_mcps(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_boss_name        ON agents(is_boss DESC, name ASC);
CREATE INDEX IF NOT EXISTS idx_agents_boss_created     ON agents(is_boss DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled     ON mcp_servers(enabled) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled  ON scheduled_jobs(enabled) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_snapshots_agent_created ON agent_snapshots(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_access_agent      ON agent_access(agent_id);
-- Perf: agent_access PK is (agent_id, user_id); the leading column means
-- user_id-direction scans (find all access for user X) skip the PK. This
-- index covers JOINs that filter on aa.user_id.
CREATE INDEX IF NOT EXISTS idx_agent_access_user       ON agent_access(user_id);
-- Perf: many permission gates filter agents by created_by. Without this
-- index a full table scan is needed on every userCanRead/Write check.
CREATE INDEX IF NOT EXISTS idx_agents_created_by       ON agents(created_by);
CREATE INDEX IF NOT EXISTS idx_agent_groups_agent       ON agent_groups(agent_id);
-- uniq_agent_groups_priority is created in the migration block below so we
-- can defensively bump pre-existing duplicate priorities before enforcing
-- uniqueness; running CREATE UNIQUE INDEX here would crash startup on dirty data.
CREATE INDEX IF NOT EXISTS idx_agent_group_members_user ON agent_group_members(user_id);
-- idx_users_created was unused. Dropped in the migration block below.
CREATE INDEX IF NOT EXISTS idx_job_runs_job            ON job_runs(job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_restrictions_agent ON agent_restrictions(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_last_activity     ON tasks(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_platform_keys     ON tasks(platform, channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_activities_task         ON activities(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_activities_agent        ON activities(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_started      ON activities(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_in_progress  ON activities(status) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_activities_status_agent ON activities(status, agent_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_platform_integrations_platform ON platform_integrations(platform, enabled) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_tool_calls_activity     ON tool_calls(activity_id, started_at);

-- Evals (Tier 2 regression eval — see docs/evals/T2-PLAN.md)
CREATE TABLE IF NOT EXISTS eval_cases (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('approved', 'proposed')),
  question      TEXT NOT NULL,
  checks        TEXT NOT NULL,           -- JSON array of CheckConfig
  approved_by   TEXT,
  approved_at   TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  triggered_by  TEXT NOT NULL,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'done', 'cancelled', 'error')),
  pass_count    INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  suspect_count INTEGER NOT NULL DEFAULT 0,
  infra_count   INTEGER NOT NULL DEFAULT 0,
  total_ms      INTEGER
);

CREATE TABLE IF NOT EXISTS eval_run_results (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id         TEXT NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  verdict         TEXT NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'SUSPECT', 'INFRA')),
  time_ms         INTEGER NOT NULL,
  final_reply     TEXT,
  tool_calls      TEXT,                  -- JSON array of ToolCallTrace
  check_results   TEXT NOT NULL,         -- JSON array of CheckResult
  judge_reasoning TEXT
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_agent_status ON eval_cases(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_eval_runs_agent_started ON eval_runs(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_run_results_run    ON eval_run_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_run_results_case   ON eval_run_results(case_id);

-- 👍/👎 feedback on an agent's final reply (Slack buttons). One row per
-- (message, rater); re-rating updates it. note is captured via the 👎 modal.
CREATE TABLE IF NOT EXISTS message_feedback (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  activity_id   TEXT REFERENCES activities(id) ON DELETE SET NULL,
  channel       TEXT,
  message_ts    TEXT,
  rater_user_id TEXT,
  rater_handle  TEXT,
  sentiment     TEXT NOT NULL CHECK (sentiment IN ('up', 'down')),
  note          TEXT,
  permalink     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_ts, rater_user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_feedback_agent ON message_feedback(agent_id, created_at DESC);

-- ── LLM trace spans (OpenTelemetry GenAI semantic conventions) ──────────────
-- One row per observation in a turn's span tree: the turn itself (kind='agent',
-- = an activity / invoke_agent span), each LLM step (kind='generation', carries
-- reasoning + text + per-step model/tokens), each tool execution
-- (kind='tool' / execute_tool, full args + result), and system markers
-- (kind='event', e.g. context_reset). session_id is the task id (the thread).
-- Timestamps are epoch MILLISECONDS for exact, sub-second durations. Content
-- columns (input/output/reasoning) are gated by TRACE_CAPTURE_CONTENT at write
-- time. Written by the runner's DbSpanExporter (OTel SimpleSpanProcessor).
CREATE TABLE IF NOT EXISTS spans (
  span_id               TEXT PRIMARY KEY,
  trace_id              TEXT NOT NULL,
  parent_span_id        TEXT,
  session_id            TEXT NOT NULL,
  activity_id           TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('agent','generation','tool','event')),
  name                  TEXT NOT NULL,
  agent_id              TEXT,
  provider              TEXT,
  model                 TEXT,
  start_ms              INTEGER NOT NULL,
  end_ms                INTEGER,
  status                TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
  status_message        TEXT,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  reasoning_tokens      INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd              REAL,
  finish_reason         TEXT,
  tool_name             TEXT,
  input                 TEXT,
  output                TEXT,
  reasoning             TEXT,
  sensitive             INTEGER NOT NULL DEFAULT 0,
  sensitive_categories  TEXT,
  sensitive_reason      TEXT,
  sensitive_severity    TEXT,
  sensitive_fps         TEXT,
  sensitive_llm         INTEGER NOT NULL DEFAULT 0,
  sensitive_llm_hits    TEXT,
  attributes            TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_spans_session  ON spans(session_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_spans_activity ON spans(activity_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_spans_trace    ON spans(trace_id);
-- Covers the per-agent rollup / tool / sensitive aggregate queries (agent_id + window).
CREATE INDEX IF NOT EXISTS idx_spans_agent_start ON spans(agent_id, start_ms);
-- Lets the per-task EXISTS(spans … sensitive=1) check terminate on the index.
CREATE INDEX IF NOT EXISTS idx_spans_session_sensitive ON spans(session_id, sensitive);
`;

// =============================================================================
// UUID trigger — auto-generate UUIDs for INSERT statements
// =============================================================================

/**
 * Creates and initializes a SQLite database with the SlackHive schema.
 *
 * @param dbPath - Path to the SQLite database file.
 *                 Defaults to ~/.slackhive/data.db
 * @returns The initialized adapter.
 */
export function createSqliteAdapter(dbPath?: string): DbAdapter {
  const resolvedPath = dbPath ?? path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
    '.slackhive',
    'data.db'
  );

  // Ensure directory exists with restricted permissions (owner-only)
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const db = new Database(resolvedPath);

  // Restrict database file to owner-only (contains Slack tokens and secrets)
  try {
    fs.chmodSync(resolvedPath, 0o600);
  } catch { /* Windows doesn't support chmod */ }

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Enable foreign keys (disabled by default in SQLite)
  db.pragma('foreign_keys = ON');
  // Reasonable busy timeout for concurrent access
  db.pragma('busy_timeout = 5000');

  // Initialize schema
  db.exec(SQLITE_SCHEMA);

  // Column migrations — add new columns to existing tables (safe to re-run)
  const agentCols = (db.pragma('table_info(agents)') as { name: string }[]).map(c => c.name);
  if (!agentCols.includes('verbose')) {
    db.exec('ALTER TABLE agents ADD COLUMN verbose INTEGER NOT NULL DEFAULT 1');
  }
  if (!agentCols.includes('sensitivity_check')) {
    db.exec("ALTER TABLE agents ADD COLUMN sensitivity_check TEXT NOT NULL DEFAULT 'deterministic'");
  }
  if (!agentCols.includes('enforcement_redaction')) {
    db.exec('ALTER TABLE agents ADD COLUMN enforcement_redaction INTEGER NOT NULL DEFAULT 0');
  }
  if (!agentCols.includes('redaction_level')) {
    db.exec("ALTER TABLE agents ADD COLUMN redaction_level TEXT NOT NULL DEFAULT 'secrets'");
  }
  // sensitivity_guidance — free-text "what counts as sensitive for THIS agent",
  // fed into the Smart (LLM) detector prompt.
  if (!agentCols.includes('sensitivity_guidance')) {
    db.exec("ALTER TABLE agents ADD COLUMN sensitivity_guidance TEXT NOT NULL DEFAULT ''");
  }
  if (!agentCols.includes('last_error')) {
    db.exec('ALTER TABLE agents ADD COLUMN last_error TEXT');
  }
  if (!agentCols.includes('runner_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN runner_id TEXT');
  }
  if (!agentCols.includes('last_heartbeat')) {
    db.exec('ALTER TABLE agents ADD COLUMN last_heartbeat TEXT');
  }
  if (!agentCols.includes('tags')) {
    db.exec("ALTER TABLE agents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  }
  const userCols = (db.pragma('table_info(users)') as { name: string }[]).map(c => c.name);
  if (!userCols.includes('slack_user_id')) {
    db.exec('ALTER TABLE users ADD COLUMN slack_user_id TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slack_user_id ON users(slack_user_id) WHERE slack_user_id IS NOT NULL');
  }
  if (!userCols.includes('slack_email')) {
    db.exec('ALTER TABLE users ADD COLUMN slack_email TEXT');
  }

  const jobCols = (db.pragma('table_info(scheduled_jobs)') as { name: string }[]).map(c => c.name);
  if (!jobCols.includes('created_by')) {
    db.exec("ALTER TABLE scheduled_jobs ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system'");
  }
  if (!jobCols.includes('skip_when')) {
    db.exec('ALTER TABLE scheduled_jobs ADD COLUMN skip_when TEXT');
  }

  const jobRunCols = (db.pragma('table_info(job_runs)') as { name: string }[]).map(c => c.name);
  if (!jobRunCols.includes('posted')) {
    db.exec('ALTER TABLE job_runs ADD COLUMN posted INTEGER NOT NULL DEFAULT 1');
  }

  const skillCols = (db.pragma('table_info(skills)') as { name: string }[]).map(c => c.name);
  if (!skillCols.includes('description')) {
    db.exec('ALTER TABLE skills ADD COLUMN description TEXT');
  }

  const wikiSourceCols = (db.pragma('table_info(wiki_sources)') as { name: string }[]).map(c => c.name);
  if (!wikiSourceCols.includes('last_synced_sha')) {
    db.exec('ALTER TABLE wiki_sources ADD COLUMN last_synced_sha TEXT');
  }

  const piCols = (db.pragma('table_info(platform_integrations)') as { name: string }[]).map(c => c.name);
  if (!piCols.includes('bot_handle')) {
    db.exec('ALTER TABLE platform_integrations ADD COLUMN bot_handle TEXT');
  }
  if (!piCols.includes('bot_image_url')) {
    db.exec('ALTER TABLE platform_integrations ADD COLUMN bot_image_url TEXT');
  }
  // Auto-provisioned platform app metadata: the platform-side app id plus its
  // encrypted app credentials (for Slack: {clientId, clientSecret, verificationToken}),
  // kept separate from `credentials` which stays strictly the runner-facing blob.
  if (!piCols.includes('app_id')) {
    db.exec('ALTER TABLE platform_integrations ADD COLUMN app_id TEXT');
  }
  if (!piCols.includes('app_credentials')) {
    db.exec('ALTER TABLE platform_integrations ADD COLUMN app_credentials TEXT');
  }

  const mcpServerCols = (db.pragma('table_info(mcp_servers)') as { name: string }[]).map(c => c.name);
  if (!mcpServerCols.includes('tool_list_cache')) {
    db.exec('ALTER TABLE mcp_servers ADD COLUMN tool_list_cache TEXT');
  }
  if (!mcpServerCols.includes('tool_list_cached_at')) {
    db.exec('ALTER TABLE mcp_servers ADD COLUMN tool_list_cached_at TEXT');
  }

  const feedbackCols = (db.pragma('table_info(message_feedback)') as { name: string }[]).map(c => c.name);
  if (!feedbackCols.includes('permalink')) {
    db.exec('ALTER TABLE message_feedback ADD COLUMN permalink TEXT');
  }

  // Rebuild wiki_sources if its status CHECK constraint pre-dates 'stale'.
  // SQLite CHECK constraints can't be altered — need full table rebuild.
  // Symptom on stale schemas: PATCH that marks a compiled source 'stale'
  // silently fails with SQLITE_CONSTRAINT_CHECK and the user's edit is lost.
  const wikiSourcesSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='wiki_sources'"
  ).get() as { sql: string } | undefined)?.sql ?? '';
  if (wikiSourcesSchema && !wikiSourcesSchema.includes("'stale'")) {
    db.exec(`
      CREATE TABLE wiki_sources_new (
        id          TEXT PRIMARY KEY,
        folder_id   TEXT NOT NULL REFERENCES wiki_folders(id) ON DELETE CASCADE,
        type        TEXT NOT NULL CHECK (type IN ('url', 'file', 'repo')),
        name        TEXT NOT NULL,
        content     TEXT,
        url         TEXT,
        repo_url    TEXT,
        branch      TEXT DEFAULT 'main',
        pat_env_ref TEXT,
        status      TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'building', 'compiled', 'stale', 'error')),
        word_count  INTEGER DEFAULT 0,
        last_synced TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (folder_id, name)
      );
      INSERT INTO wiki_sources_new
        SELECT id, folder_id, type, name, content, url, repo_url, branch,
               pat_env_ref, status, word_count, last_synced, created_at
          FROM wiki_sources;
      DROP TABLE wiki_sources;
      ALTER TABLE wiki_sources_new RENAME TO wiki_sources;
    `);
  }

  const accessCols = (db.pragma('table_info(agent_access)') as { name: string }[]).map(c => c.name);
  if (!accessCols.includes('can_write')) {
    db.exec('ALTER TABLE agent_access ADD COLUMN can_write INTEGER NOT NULL DEFAULT 1');
  }

  // agent_groups.verbose was added after the initial table; backfill for installs
  // that already migrated the table without the column.
  const groupCols = (db.pragma('table_info(agent_groups)') as { name: string }[]).map(c => c.name);
  if (groupCols.length > 0 && !groupCols.includes('verbose')) {
    db.exec('ALTER TABLE agent_groups ADD COLUMN verbose INTEGER NOT NULL DEFAULT 0');
  }

  // Tiered memory: pinned ("remember always") + per-sender scoping ("who is
  // asking"). Defaults reproduce the prior behavior (unpinned, global scope).
  const memoryCols = (db.pragma('table_info(memories)') as { name: string }[]).map(c => c.name);
  if (memoryCols.length > 0 && !memoryCols.includes('pinned')) {
    db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }
  if (memoryCols.length > 0 && !memoryCols.includes('scope_user_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN scope_user_id TEXT');
  }
  if (memoryCols.length > 0 && !memoryCols.includes('scope_group_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN scope_group_id TEXT');
  }
  if (memoryCols.length > 0 && !memoryCols.includes('created_by')) {
    db.exec('ALTER TABLE memories ADD COLUMN created_by TEXT');
  }
  if (memoryCols.length > 0 && !memoryCols.includes('source')) {
    db.exec('ALTER TABLE memories ADD COLUMN source TEXT');
  }
  // Indexes for the new columns live HERE (not in the schema DDL) — the DDL runs
  // before this migration, so on an existing DB the columns don't exist yet when
  // the DDL executes. Running after the ALTERs above, they're safe on both fresh
  // and migrated databases.
  if (memoryCols.length > 0) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_pinned     ON memories(agent_id, pinned)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_scope_user ON memories(agent_id, scope_user_id)');
  }

  // Defensive: agent_groups.(agent_id, priority) must be unique. If an earlier
  // dev build allowed duplicates, bump them before creating the unique index
  // so startup doesn't crash on dirty data.
  if (groupCols.length > 0) {
    const indexes = db.pragma("index_list('agent_groups')") as { name: string }[];
    const hasUniq = indexes.some(i => i.name === 'uniq_agent_groups_priority');
    if (!hasUniq) {
      const dupes = db.prepare(`
        SELECT agent_id, priority, COUNT(*) AS n
          FROM agent_groups
         GROUP BY agent_id, priority
         HAVING n > 1
      `).all() as { agent_id: string; priority: number; n: number }[];
      if (dupes.length > 0) {
        // For each dup-set, leave the oldest (lowest created_at) at the original
        // priority and bump the rest to the next free slots. We pick from
        // ORDER BY priority DESC so we open up gaps without creating new
        // collisions on already-used numbers.
        const fix = db.transaction(() => {
          for (const d of dupes) {
            const rows = db.prepare(`
              SELECT id FROM agent_groups
               WHERE agent_id = ? AND priority = ?
               ORDER BY created_at ASC, id ASC
            `).all(d.agent_id, d.priority) as { id: string }[];
            // Skip the first; bump the rest to (max+1, max+2, …).
            const taken = new Set(
              (db.prepare('SELECT priority FROM agent_groups WHERE agent_id = ?').all(d.agent_id) as { priority: number }[])
                .map(r => r.priority)
            );
            for (let i = 1; i < rows.length; i++) {
              let p = d.priority + 1;
              while (taken.has(p)) p++;
              taken.add(p);
              db.prepare('UPDATE agent_groups SET priority = ?, updated_at = datetime(\'now\') WHERE id = ?').run(p, rows[i].id);
            }
          }
        });
        fix();
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_groups_priority ON agent_groups(agent_id, priority)');
    }
  }
  if (!accessCols.includes('access_level')) {
    // Migrate can_write → access_level, then recreate table without can_write
    db.exec(`
      ALTER TABLE agent_access ADD COLUMN access_level TEXT NOT NULL DEFAULT 'edit';
      UPDATE agent_access SET access_level = CASE WHEN can_write = 1 THEN 'edit' ELSE 'view' END;
    `);
  }

  const mcpCols = (db.pragma('table_info(mcp_servers)') as { name: string }[]).map(c => c.name);
  if (!mcpCols.includes('created_by')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin'`);
  }

  const envVarCols = (db.pragma('table_info(env_vars)') as { name: string }[]).map(c => c.name);
  if (!envVarCols.includes('created_by')) {
    db.exec(`ALTER TABLE env_vars ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin'`);
  }

  const activityCols = (db.pragma('table_info(activities)') as { name: string }[]).map(c => c.name);
  if (!activityCols.includes('input_tokens')) {
    db.exec('ALTER TABLE activities ADD COLUMN input_tokens INTEGER');
  }
  if (!activityCols.includes('output_tokens')) {
    db.exec('ALTER TABLE activities ADD COLUMN output_tokens INTEGER');
  }
  if (!activityCols.includes('cache_read_tokens')) {
    db.exec('ALTER TABLE activities ADD COLUMN cache_read_tokens INTEGER');
  }
  if (!activityCols.includes('cache_creation_tokens')) {
    db.exec('ALTER TABLE activities ADD COLUMN cache_creation_tokens INTEGER');
  }
  if (!activityCols.includes('initiator_handle')) {
    db.exec('ALTER TABLE activities ADD COLUMN initiator_handle TEXT');
  }
  // Durable link from a posted reply (Slack message ts) to its activity, so
  // feedback clicks resolve the turn even after a runner restart clears the
  // in-memory feedback-target map.
  if (!activityCols.includes('reply_ts')) {
    db.exec('ALTER TABLE activities ADD COLUMN reply_ts TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_activities_reply_ts ON activities(reply_ts)');
  }
  // Per-turn model, for an accurate token-by-model breakdown. New turns stamp it
  // at begin; pre-existing rows are best-effort backfilled to the agent's CURRENT
  // model (the real model wasn't recorded, so a prior Claude period folds into the
  // current model for history only — going forward each turn is attributed correctly).
  if (!activityCols.includes('model')) {
    // Atomic ALTER + backfill: if the (potentially slow) UPDATE is interrupted, the
    // whole thing rolls back so the column-add guard above stays false and the
    // migration retries next boot — rather than leaving the column added but rows
    // permanently NULL (→ a stuck 'unknown' bucket) with no recovery path.
    db.transaction(() => {
      db.exec('ALTER TABLE activities ADD COLUMN model TEXT');
      db.exec(`UPDATE activities
                  SET model = (SELECT a.model FROM agents a WHERE a.id = activities.agent_id)
                WHERE model IS NULL`);
    })();
  }

  // spans.sensitive* — added after the spans table shipped (sensitive-access monitor).
  const spanCols = (db.pragma('table_info(spans)') as { name: string }[]).map(c => c.name);
  if (spanCols.length > 0) {
    if (!spanCols.includes('sensitive')) db.exec('ALTER TABLE spans ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0');
    if (!spanCols.includes('sensitive_categories')) db.exec('ALTER TABLE spans ADD COLUMN sensitive_categories TEXT');
    if (!spanCols.includes('sensitive_reason')) db.exec('ALTER TABLE spans ADD COLUMN sensitive_reason TEXT');
    if (!spanCols.includes('sensitive_severity')) db.exec('ALTER TABLE spans ADD COLUMN sensitive_severity TEXT');
    // Per-match privacy-safe fingerprints + role (source/sink) for flow lineage.
    if (!spanCols.includes('sensitive_fps')) db.exec('ALTER TABLE spans ADD COLUMN sensitive_fps TEXT');
    // sensitive_llm — marks a span the Smart (LLM) detector flagged independently
    // of regex (e.g. obfuscated PII). Surfaced as a "caught by LLM" badge.
    if (!spanCols.includes('sensitive_llm')) db.exec('ALTER TABLE spans ADD COLUMN sensitive_llm INTEGER NOT NULL DEFAULT 0');
    // sensitive_llm_hits — JSON [{text,category,label,severity}] of the excerpts the
    // Smart detector flagged, so the trace can highlight which part + what type.
    if (!spanCols.includes('sensitive_llm_hits')) db.exec('ALTER TABLE spans ADD COLUMN sensitive_llm_hits TEXT');
  }
  // Partial index for the audit feed (only flagged rows).
  db.exec("CREATE INDEX IF NOT EXISTS idx_spans_sensitive ON spans(start_ms DESC) WHERE sensitive = 1");

  // Perf: drop unused index that no query touches (users.created_at). The new
  // hot-path indexes (idx_agent_access_user, idx_agents_created_by) are
  // created via the main DDL's `CREATE INDEX IF NOT EXISTS` and apply to both
  // fresh installs and existing ones on startup.
  db.exec('DROP INDEX IF EXISTS idx_users_created');

  // Migrate legacy knowledge_sources → wiki_folders / wiki_sources / agent_wiki_folders
  // Runs once: only if knowledge_sources has rows but agent_wiki_folders is empty
  const hasMigrated = (db.prepare('SELECT COUNT(*) as n FROM agent_wiki_folders').get() as { n: number }).n > 0;
  const legacyCount = (db.prepare('SELECT COUNT(*) as n FROM knowledge_sources').get() as { n: number }).n;
  if (!hasMigrated && legacyCount > 0) {
    const legacyAgents = db.prepare(`
      SELECT DISTINCT ks.agent_id, a.name as agent_name, a.slug as agent_slug
      FROM knowledge_sources ks
      JOIN agents a ON a.id = ks.agent_id
    `).all() as { agent_id: string; agent_name: string; agent_slug: string }[];

    const insertFolder = db.prepare(`
      INSERT OR IGNORE INTO wiki_folders (id, name, description, created_by)
      VALUES (?, ?, ?, 'system')
    `);
    const insertSource = db.prepare(`
      INSERT OR IGNORE INTO wiki_sources (id, folder_id, type, name, content, url, repo_url, branch, pat_env_ref, status, word_count, last_synced, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO agent_wiki_folders (agent_id, folder_id) VALUES (?, ?)
    `);

    // Collect slug→folderId mapping so we can copy built wiki files after the transaction
    const diskMigrations: { slug: string; folderId: string }[] = [];

    const migrate = db.transaction(() => {
      for (const { agent_id, agent_name, agent_slug } of legacyAgents) {
        const folderId = randomUUID();
        insertFolder.run(folderId, `${agent_name} Knowledge`, `Auto-migrated from ${agent_name}`);
        insertLink.run(agent_id, folderId);
        diskMigrations.push({ slug: agent_slug, folderId });

        const sources = db.prepare('SELECT * FROM knowledge_sources WHERE agent_id = ?').all(agent_id) as Record<string, unknown>[];
        for (const s of sources) {
          insertSource.run(
            randomUUID(), folderId,
            s.type, s.name, s.content ?? null,
            s.url ?? null, s.repo_url ?? null,
            s.branch ?? 'main', s.pat_env_ref ?? null,
            s.status, s.word_count ?? 0, s.last_synced ?? null,
            s.created_at,
          );
        }
      }
    });
    migrate();

    // Copy built wiki pages from old per-agent disk location to new platform location.
    // Runs for each folder whose new wiki dir doesn't exist yet (safe to re-run).
    // Old: ~/.slackhive/agents/{slug}/knowledge/wiki/
    // New: ~/.slackhive/knowledge/{folder-id}/wiki/
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    const slackhiveDir = path.join(home, '.slackhive');
    for (const { slug, folderId } of diskMigrations) {
      const oldWikiDir = path.join(slackhiveDir, 'agents', slug, 'knowledge', 'wiki');
      const newWikiDir = path.join(slackhiveDir, 'knowledge', folderId, 'wiki');
      if (fs.existsSync(oldWikiDir) && !fs.existsSync(newWikiDir)) {
        try {
          fs.mkdirSync(path.dirname(newWikiDir), { recursive: true });
          fs.cpSync(oldWikiDir, newWikiDir, { recursive: true });
        } catch {
          // Non-fatal — wiki can be rebuilt
        }
      }
    }
  }

  // Also run disk migration for any already-migrated folders that are missing their wiki dir.
  // This handles the case where the DB migration ran before disk migration was implemented.
  {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    const slackhiveDir = path.join(home, '.slackhive');
    const agentFolderLinks = db.prepare(`
      SELECT wf.id as folder_id, a.slug
      FROM wiki_folders wf
      JOIN agent_wiki_folders awf ON awf.folder_id = wf.id
      JOIN agents a ON a.id = awf.agent_id
    `).all() as { folder_id: string; slug: string }[];

    for (const { folder_id, slug } of agentFolderLinks) {
      const oldWikiDir = path.join(slackhiveDir, 'agents', slug, 'knowledge', 'wiki');
      const newWikiDir = path.join(slackhiveDir, 'knowledge', folder_id, 'wiki');
      if (fs.existsSync(oldWikiDir) && !fs.existsSync(newWikiDir)) {
        try {
          fs.mkdirSync(path.dirname(newWikiDir), { recursive: true });
          fs.cpSync(oldWikiDir, newWikiDir, { recursive: true });
        } catch {
          // Non-fatal
        }
      }
    }
  }

  // Install a custom function to generate UUIDs
  // This lets DEFAULT gen_random_uuid()-style behavior work via triggers
  db.function('gen_random_uuid', () => randomUUID());

  // Create triggers to auto-generate UUIDs for tables that need them.
  // SQLite doesn't support DEFAULT gen_random_uuid(), so we use BEFORE INSERT triggers.
  const tablesWithUuid = [
    'agents', 'mcp_servers', 'skills', 'permissions', 'memories',
    'sessions', 'users', 'scheduled_jobs', 'job_runs', 'agent_snapshots',
    'agent_restrictions', 'tasks', 'activities', 'tool_calls',
    'wiki_folders', 'wiki_sources',
  ];

  for (const table of tablesWithUuid) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_auto_uuid
      BEFORE INSERT ON ${table}
      FOR EACH ROW
      WHEN NEW.id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'id must be provided');
      END;
    `);
  }

  // Create triggers to auto-update updated_at on UPDATE
  // Use rowid for universal compatibility (env_vars uses 'key' not 'id')
  const tablesWithUpdatedAt = [
    'agents', 'skills', 'memories', 'env_vars', 'agent_restrictions',
  ];

  for (const table of tablesWithUpdatedAt) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_auto_updated_at
      BEFORE UPDATE ON ${table}
      FOR EACH ROW
      BEGIN
        UPDATE ${table} SET updated_at = datetime('now') WHERE rowid = NEW.rowid;
      END;
    `);
  }

  return new SqliteAdapter(db);
}
