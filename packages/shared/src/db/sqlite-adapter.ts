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

    // Determine if this is a SELECT (read) or write operation
    const trimmed = translatedSql.trim().toUpperCase();
    const isSelect = trimmed.startsWith('SELECT');
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
  reports_to           TEXT NOT NULL DEFAULT '[]',
  claude_md            TEXT NOT NULL DEFAULT '',
  created_by           TEXT NOT NULL DEFAULT 'system',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  type        TEXT NOT NULL DEFAULT 'stdio'
                   CHECK (type IN ('stdio', 'sse', 'http')),
  config      TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_mcps (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_id   TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, mcp_id)
);

CREATE TABLE IF NOT EXISTS skills (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  filename   TEXT NOT NULL,
  content    TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
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
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer'
                     CHECK (role IN ('admin', 'editor', 'viewer')),
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
  error       TEXT
);

CREATE TABLE IF NOT EXISTS agent_access (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, user_id)
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
  enabled     INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, platform)
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
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'compiled', 'error')),
  word_count  INTEGER DEFAULT 0,
  last_synced TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX IF NOT EXISTS idx_users_created           ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_job_runs_job            ON job_runs(job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_restrictions_agent ON agent_restrictions(agent_id);
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

  // Install a custom function to generate UUIDs
  // This lets DEFAULT gen_random_uuid()-style behavior work via triggers
  db.function('gen_random_uuid', () => randomUUID());

  // Create triggers to auto-generate UUIDs for tables that need them.
  // SQLite doesn't support DEFAULT gen_random_uuid(), so we use BEFORE INSERT triggers.
  const tablesWithUuid = [
    'agents', 'mcp_servers', 'skills', 'permissions', 'memories',
    'sessions', 'users', 'scheduled_jobs', 'job_runs', 'agent_snapshots',
    'agent_restrictions',
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
