-- Migration: multi-boss support
-- Changes reports_to from a single UUID foreign key to a UUID array,
-- allowing an agent to report to multiple boss agents.

ALTER TABLE agents
  DROP COLUMN IF EXISTS reports_to;

ALTER TABLE agents
  ADD COLUMN reports_to UUID[] NOT NULL DEFAULT '{}';
