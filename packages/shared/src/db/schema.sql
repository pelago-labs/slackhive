-- =============================================================================
-- SlackHive — Database Schema
-- PostgreSQL 16+
--
-- Tables:
--   agents       — Registered Slack bots (one per Claude Code agent)
--   mcp_servers  — Global MCP server catalog (platform-level, shared)
--   agent_mcps   — Which MCP servers each agent uses (many-to-many)
--   skills       — Markdown skill files per agent (compiled into CLAUDE.md)
--   permissions  — Tool allowlist/denylist per agent
--   memories     — Learned memories per agent (persisted from runtime)
--   sessions     — Slack thread → Claude session ID mapping
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- agents
-- Each row represents one Slack bot backed by a Claude Code SDK session manager.
-- The runner spins up one @slack/bolt App instance per active agent.
-- -----------------------------------------------------------------------------
CREATE TABLE agents (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 TEXT        UNIQUE NOT NULL,
  name                 TEXT        NOT NULL,
  persona              TEXT,
  description          TEXT,
  slack_bot_token      TEXT        NOT NULL,
  slack_app_token      TEXT        NOT NULL,
  slack_signing_secret TEXT        NOT NULL,
  -- Populated automatically on first successful Slack connection via auth.test.
  -- Used by the boss agent to construct <@UXXXXXXX> Slack mentions.
  slack_bot_user_id    TEXT,
  model                TEXT        NOT NULL DEFAULT 'claude-opus-4-6',
  status               TEXT        NOT NULL DEFAULT 'stopped'
                                   CHECK (status IN ('running', 'stopped', 'error')),
  is_boss              BOOLEAN     NOT NULL DEFAULT false,
  -- Array of boss agent UUIDs this agent reports to. Empty = top-level boss.
  reports_to           UUID[]      NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- mcp_servers
-- Platform-level catalog of available MCP servers.
-- Defined once, reused by any agent.
-- Settings page at /settings/mcps manages this table.
-- -----------------------------------------------------------------------------
CREATE TABLE mcp_servers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        UNIQUE NOT NULL,
  type        TEXT        NOT NULL DEFAULT 'stdio'
                          CHECK (type IN ('stdio', 'sse', 'http')),
  -- JSON config shape depends on type:
  --   stdio: { command, args?, env? }
  --   sse:   { url, headers? }
  --   http:  { url, headers? }
  config      JSONB       NOT NULL,
  description TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- agent_mcps
-- Maps which MCP servers an agent uses.
-- When the runner starts an agent, it loads all rows for that agent_id
-- and passes them to the Claude Code SDK as mcpServers config.
-- -----------------------------------------------------------------------------
CREATE TABLE agent_mcps (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_id   UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, mcp_id)
);

-- -----------------------------------------------------------------------------
-- skills
-- Markdown skill files that define an agent's knowledge and behavior.
-- Compiled in order (category ASC, sort_order ASC) into CLAUDE.md.
-- The runner writes CLAUDE.md to /tmp/agents/{slug}/CLAUDE.md at startup.
-- -----------------------------------------------------------------------------
CREATE TABLE skills (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  category   TEXT        NOT NULL,  -- e.g. "00-core", "01-knowledge"
  filename   TEXT        NOT NULL,  -- e.g. "identity.md"
  content    TEXT        NOT NULL,
  sort_order INT         NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, category, filename)
);

-- -----------------------------------------------------------------------------
-- permissions
-- Tool allowlist/denylist for each agent.
-- Passed to the Claude Code SDK as allowedTools/deniedTools options.
-- One row per agent (UNIQUE on agent_id).
-- -----------------------------------------------------------------------------
CREATE TABLE permissions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE UNIQUE,
  allowed_tools TEXT[]      NOT NULL DEFAULT '{}',
  denied_tools  TEXT[]      NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- memories
-- Persistent memory entries for each agent.
--
-- PRIMARY LEARNING MECHANISM:
-- When an agent processes a conversation, the Claude Code SDK may write
-- memory files to /tmp/agents/{slug}/.claude/memory/.
-- The runner watches this directory with fs.watch() and upserts any changes
-- into this table. On the next startup, memories are re-materialized to disk
-- so the agent retains everything it has learned from past interactions.
--
-- Memory is also compiled into the bottom of CLAUDE.md so it is always
-- in context, enabling agents to continuously improve.
-- -----------------------------------------------------------------------------
CREATE TABLE memories (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type       TEXT        NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  name       TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- sessions
-- Maps Slack thread context to Claude Code SDK session IDs.
-- Enables conversation continuity: users return to a thread and the agent
-- resumes exactly where it left off.
-- Replaces the JSON file used in the original nlq-claude-slack-bot.
-- -----------------------------------------------------------------------------
CREATE TABLE sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Composite key: {userId}-{channelId}-{threadTs|'direct'}
  session_key       TEXT        NOT NULL,
  -- Returned by Claude Code SDK system:init message. Passed as options.resume.
  claude_session_id TEXT,
  last_activity     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, session_key)
);

-- -----------------------------------------------------------------------------
-- settings
-- Key-value store for platform-level configuration (branding, etc.).
-- Managed via the /settings page in the web UI.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- users
-- Platform users with role-based access.
-- Superadmin is configured via env vars and never stored here.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'viewer'
                            CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- scheduled_jobs
-- Recurring tasks executed by the boss agent on a cron schedule.
-- Results are posted to a Slack channel or DM.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  prompt        TEXT        NOT NULL,
  cron_schedule TEXT        NOT NULL,
  target_type   TEXT        NOT NULL DEFAULT 'channel'
                            CHECK (target_type IN ('channel', 'dm')),
  target_id     TEXT        NOT NULL,       -- Slack channel ID or user ID
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- job_runs
-- Execution history for scheduled jobs.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_runs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID        NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status      TEXT        NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running', 'success', 'error')),
  output      TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, started_at DESC);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
CREATE INDEX idx_sessions_agent_key  ON sessions(agent_id, session_key);
CREATE INDEX idx_sessions_activity   ON sessions(last_activity);
CREATE INDEX idx_skills_agent_order  ON skills(agent_id, category, sort_order);
CREATE INDEX idx_memories_agent_type ON memories(agent_id, type);
CREATE INDEX idx_agent_mcps_agent    ON agent_mcps(agent_id);

-- -----------------------------------------------------------------------------
-- Triggers: auto-update updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER skills_updated_at
  BEFORE UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
