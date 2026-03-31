-- =============================================================================
-- Migration: add claude_md column to agents table
--
-- CLAUDE.md is now a first-class agent property, separate from skills.
-- Skills are Claude Code slash commands written to .claude/commands/.
-- CLAUDE.md is the agent's main instruction/identity file.
-- =============================================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS claude_md TEXT NOT NULL DEFAULT '';
