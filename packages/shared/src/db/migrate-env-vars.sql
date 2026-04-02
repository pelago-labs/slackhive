-- Migration: Platform Env Vars store
--
-- Adds the env_vars table for storing named secrets that can be referenced
-- by MCP stdio configs via config.envRefs instead of embedding raw values.
-- Values are encrypted at rest using pgcrypto symmetric encryption with
-- the ENV_SECRET_KEY environment variable.
--
-- After running this migration:
--   1. Add ENV_SECRET_KEY=<random-32-char-string> to your .env file
--   2. Restart all services (docker compose restart)
--   3. Add your secrets in Settings → Env Vars in the web UI
--   4. Update MCP configs to use env ref mode for those keys

CREATE TABLE IF NOT EXISTS env_vars (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER env_vars_updated_at
  BEFORE UPDATE ON env_vars
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
