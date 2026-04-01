-- Migration: Move redshift-mcp DATABASE_URL to envRefs
--
-- Removes the inline DATABASE_URL from the redshift-mcp config and replaces
-- it with an envRef pointing to the REDSHIFT_DATABASE_URL key in env_vars.
--
-- Prerequisites:
--   1. Run migrate-env-vars.sql first
--   2. Add REDSHIFT_DATABASE_URL in Settings → Env Vars (or via the INSERT below)
--
-- To seed the REDSHIFT_DATABASE_URL value directly in the DB (run psql as slackhive user):
--
--   INSERT INTO env_vars (key, value, description)
--   VALUES (
--     'REDSHIFT_DATABASE_URL',
--     pgp_sym_encrypt('<your-connection-string>', '<your-ENV_SECRET_KEY>'),
--     'Redshift read-only connection string'
--   )
--   ON CONFLICT (key) DO NOTHING;
--
-- Then run this migration to update the MCP config:

UPDATE mcp_servers
SET config = jsonb_build_object(
  'command', config->>'command',
  'args',    config->'args',
  'envRefs', jsonb_build_object('DATABASE_URL', 'REDSHIFT_DATABASE_URL')
)
WHERE name = 'redshift-mcp'
  AND config->'env' ? 'DATABASE_URL';
