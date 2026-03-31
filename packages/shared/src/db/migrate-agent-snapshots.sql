-- Migration: Agent Version Control — agent_snapshots table
--
-- Stores immutable point-in-time snapshots of an agent's full configuration:
-- skills, permissions, MCP assignments, and compiled CLAUDE.md.
--
-- Auto-snapshots (trigger != 'manual') are capped at 50 per agent in app code.
-- Manual snapshots are never auto-purged.

CREATE TABLE IF NOT EXISTS agent_snapshots (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Optional human-readable label. NULL for auto-snapshots.
  label         TEXT,

  -- What caused this snapshot.
  trigger       TEXT        NOT NULL
                            CHECK (trigger IN ('skills', 'permissions', 'mcps', 'manual')),

  -- Username of the person whose action triggered the snapshot.
  created_by    TEXT        NOT NULL DEFAULT 'system',

  -- Full skills array at snapshot time.
  -- Each element: { category, filename, content, sort_order }
  skills_json   JSONB       NOT NULL DEFAULT '[]',

  -- Permissions at snapshot time (mirrors the permissions table columns).
  allowed_tools TEXT[]      NOT NULL DEFAULT '{}',
  denied_tools  TEXT[]      NOT NULL DEFAULT '{}',

  -- UUIDs of MCP servers assigned at snapshot time.
  mcp_ids       UUID[]      NOT NULL DEFAULT '{}',

  -- Pre-compiled skills-only CLAUDE.md (no memories section).
  compiled_md   TEXT        NOT NULL DEFAULT '',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_agent_created
  ON agent_snapshots(agent_id, created_at DESC);
