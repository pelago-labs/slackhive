/**
 * @fileoverview PostgreSQL database client for the runner service.
 *
 * Provides a singleton Pool instance and typed query helpers for all
 * tables used by the runner: agents, mcp_servers, agent_mcps, skills,
 * permissions, memories, and sessions.
 *
 * @module runner/db
 */

import { Pool, PoolClient } from 'pg';
import { logger } from './logger';
import type {
  Agent,
  McpServer,
  AgentMcp,
  ScheduledJob,
  Skill,
  Permission,
  Restriction,
  Memory,
  Session,
  AgentStatus,
} from '@slackhive/shared';

/** Singleton Postgres connection pool. */
let pool: Pool | null = null;

/**
 * Returns the singleton Postgres connection pool.
 * Creates the pool on first call using DATABASE_URL from environment.
 *
 * @returns {Pool} The Postgres connection pool.
 * @throws {Error} If DATABASE_URL is not set.
 */
export function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err) => {
      logger.error('Unexpected pool error', { error: (err as Error).message });
    });
  }
  return pool;
}

/**
 * Closes the Postgres connection pool.
 * Should be called on graceful shutdown.
 *
 * @returns {Promise<void>}
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// =============================================================================
// Row mappers — convert snake_case DB columns to camelCase TS interfaces
// =============================================================================

/**
 * Maps a raw database row to an {@link Agent} interface.
 *
 * @param {Record<string, unknown>} row - Raw row from the agents table.
 * @returns {Agent} Typed agent object.
 */
function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    persona: row.persona as string | undefined,
    description: row.description as string | undefined,
    slackBotToken: row.slack_bot_token as string,
    slackAppToken: row.slack_app_token as string,
    slackSigningSecret: row.slack_signing_secret as string,
    slackBotUserId: row.slack_bot_user_id as string | undefined,
    model: row.model as string,
    status: row.status as AgentStatus,
    isBoss: row.is_boss as boolean,
    reportsTo: (row.reports_to as string[]) ?? [],
    claudeMd: (row.claude_md as string) ?? '',
    createdBy: (row.created_by as string) ?? 'system',
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Maps a raw database row to a {@link McpServer} interface.
 *
 * @param {Record<string, unknown>} row - Raw row from the mcp_servers table.
 * @returns {McpServer} Typed MCP server object.
 */
function rowToMcpServer(row: Record<string, unknown>): McpServer {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as McpServer['type'],
    config: row.config as McpServer['config'],
    description: row.description as string | undefined,
    enabled: row.enabled as boolean,
    createdAt: row.created_at as Date,
  };
}

/**
 * Maps a raw database row to a {@link Skill} interface.
 *
 * @param {Record<string, unknown>} row - Raw row from the skills table.
 * @returns {Skill} Typed skill object.
 */
function rowToSkill(row: Record<string, unknown>): Skill {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    category: row.category as string,
    filename: row.filename as string,
    content: row.content as string,
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Maps a raw database row to a {@link Permission} interface.
 *
 * @param {Record<string, unknown>} row - Raw row from the permissions table.
 * @returns {Permission} Typed permission object.
 */
function rowToPermission(row: Record<string, unknown>): Permission {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    allowedTools: row.allowed_tools as string[],
    deniedTools: row.denied_tools as string[],
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Maps a raw database row to a {@link Memory} interface.
 *
 * @param {Record<string, unknown>} row - Raw row from the memories table.
 * @returns {Memory} Typed memory object.
 */
function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    type: row.type as Memory['type'],
    name: row.name as string,
    content: row.content as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Maps a raw database row to a {@link Session} interface.
 *
 * @param {Record<string, unknown>} row - Raw row from the sessions table.
 * @returns {Session} Typed session object.
 */
function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionKey: row.session_key as string,
    claudeSessionId: row.claude_session_id as string | undefined,
    lastActivity: row.last_activity as Date,
  };
}

// =============================================================================
// Agent queries
// =============================================================================

/**
 * Fetches all agents from the database.
 *
 * @returns {Promise<Agent[]>} All registered agents.
 */
export async function getAllAgents(): Promise<Agent[]> {
  const result = await getPool().query(
    'SELECT * FROM agents ORDER BY is_boss DESC, created_at ASC'
  );
  return result.rows.map(rowToAgent);
}

/**
 * Fetches a single agent by ID.
 *
 * @param {string} id - Agent UUID.
 * @returns {Promise<Agent | null>} The agent, or null if not found.
 */
export async function getAgentById(id: string): Promise<Agent | null> {
  const result = await getPool().query('SELECT * FROM agents WHERE id = $1', [id]);
  return result.rows.length > 0 ? rowToAgent(result.rows[0]) : null;
}

/**
 * Updates the runtime status of an agent.
 *
 * @param {string} id - Agent UUID.
 * @param {AgentStatus} status - New status value.
 * @returns {Promise<void>}
 */
export async function updateAgentStatus(id: string, status: AgentStatus): Promise<void> {
  await getPool().query(
    'UPDATE agents SET status = $1, updated_at = now() WHERE id = $2',
    [status, id]
  );
}

/**
 * Updates the Slack bot user ID for an agent after successful auth.test.
 *
 * @param {string} id - Agent UUID.
 * @param {string} slackBotUserId - The bot's Slack user ID (e.g., "U12345678").
 * @returns {Promise<void>}
 */
export async function updateAgentSlackUserId(id: string, slackBotUserId: string): Promise<void> {
  await getPool().query(
    'UPDATE agents SET slack_bot_user_id = $1, updated_at = now() WHERE id = $2',
    [slackBotUserId, id]
  );
}

// =============================================================================
// MCP server queries
// =============================================================================

/**
 * Fetches all MCP servers assigned to an agent, in catalog order.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<McpServer[]>} MCP servers assigned to this agent.
 */
export async function getAgentMcpServers(agentId: string): Promise<McpServer[]> {
  const result = await getPool().query(
    `SELECT m.* FROM mcp_servers m
     JOIN agent_mcps am ON am.mcp_id = m.id
     WHERE am.agent_id = $1 AND m.enabled = true
     ORDER BY m.name`,
    [agentId]
  );
  return result.rows.map(rowToMcpServer);
}

// =============================================================================
// Skills queries
// =============================================================================

/**
 * Fetches all skills for an agent, ordered for CLAUDE.md compilation.
 * Skills are ordered by category (alphabetical) then sort_order (ascending).
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Skill[]>} Ordered skill files for this agent.
 */
export async function getAgentSkills(agentId: string): Promise<Skill[]> {
  const result = await getPool().query(
    `SELECT * FROM skills
     WHERE agent_id = $1
     ORDER BY category ASC, sort_order ASC, filename ASC`,
    [agentId]
  );
  return result.rows.map(rowToSkill);
}

/**
 * Upserts a skill for an agent.
 * Conflicts on (agent_id, category, filename) update content and sort_order.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string} category - Skill category directory (e.g. `'99-corrections'`).
 * @param {string} filename - Skill filename (e.g. `'corrections.md'`).
 * @param {string} content - Full markdown content of the skill.
 * @param {number} [sortOrder=0] - Sort order within the category.
 * @returns {Promise<Skill>} The upserted skill.
 */
export async function upsertSkill(
  agentId: string,
  category: string,
  filename: string,
  content: string,
  sortOrder = 0
): Promise<Skill> {
  const result = await getPool().query(
    `INSERT INTO skills (agent_id, category, filename, content, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id, category, filename)
     DO UPDATE SET content = EXCLUDED.content, sort_order = EXCLUDED.sort_order, updated_at = now()
     RETURNING *`,
    [agentId, category, filename, content, sortOrder]
  );
  return rowToSkill(result.rows[0]);
}

/**
 * Deletes a skill by agent_id, category, and filename.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string} category - Skill category directory.
 * @param {string} filename - Skill filename.
 * @returns {Promise<boolean>} True if a row was deleted.
 */
export async function deleteSkill(
  agentId: string,
  category: string,
  filename: string,
): Promise<boolean> {
  const result = await getPool().query(
    'DELETE FROM skills WHERE agent_id = $1 AND category = $2 AND filename = $3',
    [agentId, category, filename]
  );
  return (result.rowCount ?? 0) > 0;
}

// =============================================================================
// Permissions queries
// =============================================================================

/**
 * Fetches the tool permissions for an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Permission | null>} The permission record, or null if not set.
 */
export async function getAgentPermissions(agentId: string): Promise<Permission | null> {
  const result = await getPool().query(
    'SELECT * FROM permissions WHERE agent_id = $1',
    [agentId]
  );
  return result.rows.length > 0 ? rowToPermission(result.rows[0]) : null;
}

// =============================================================================
// Restrictions queries
// =============================================================================

function rowToRestriction(row: Record<string, unknown>): Restriction {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    allowedChannels: (row.allowed_channels as string[]) ?? [],
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Fetches the channel restrictions for an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Restriction | null>} The restriction record, or null if not configured.
 */
export async function getAgentRestrictions(agentId: string): Promise<Restriction | null> {
  const result = await getPool().query(
    'SELECT * FROM agent_restrictions WHERE agent_id = $1',
    [agentId]
  );
  return result.rows.length > 0 ? rowToRestriction(result.rows[0]) : null;
}

// =============================================================================
// Memory queries
// =============================================================================

/**
 * Fetches all memory entries for an agent, ordered by type then created_at.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Memory[]>} All memory entries for this agent.
 */
export async function getAgentMemories(agentId: string): Promise<Memory[]> {
  const result = await getPool().query(
    `SELECT * FROM memories
     WHERE agent_id = $1
     ORDER BY type ASC, created_at ASC`,
    [agentId]
  );
  return result.rows.map(rowToMemory);
}

/**
 * Upserts a memory entry for an agent.
 * If a memory with the same agent_id and name already exists, it is updated.
 * Otherwise a new entry is created.
 *
 * This is called by the memory watcher when the agent writes new memory files
 * to disk during a conversation.
 *
 * @param {string} agentId - Agent UUID.
 * @param {Memory['type']} type - Memory type classification.
 * @param {string} name - Unique name/identifier for this memory.
 * @param {string} content - Full markdown content of the memory.
 * @returns {Promise<Memory>} The upserted memory record.
 */
export async function upsertMemory(
  agentId: string,
  type: Memory['type'],
  name: string,
  content: string
): Promise<Memory> {
  const result = await getPool().query(
    `INSERT INTO memories (agent_id, type, name, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, (name)) DO UPDATE
       SET content = EXCLUDED.content,
           type = EXCLUDED.type,
           updated_at = now()
     RETURNING *`,
    [agentId, type, name, content]
  );
  return rowToMemory(result.rows[0]);
}

/**
 * Upserts a memory entry by agent_id and name (no unique constraint version).
 * Uses a safe upsert pattern compatible with the current schema.
 *
 * @param {string} agentId - Agent UUID.
 * @param {Memory['type']} type - Memory type classification.
 * @param {string} name - Memory name (used as identifier).
 * @param {string} content - Full markdown content.
 * @returns {Promise<void>}
 */
export async function upsertMemorySafe(
  agentId: string,
  type: Memory['type'],
  name: string,
  content: string
): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM memories WHERE agent_id = $1 AND name = $2',
      [agentId, name]
    );
    if (existing.rows.length > 0) {
      await client.query(
        'UPDATE memories SET content = $1, type = $2, updated_at = now() WHERE id = $3',
        [content, type, existing.rows[0].id]
      );
    } else {
      await client.query(
        'INSERT INTO memories (agent_id, type, name, content) VALUES ($1, $2, $3, $4)',
        [agentId, type, name, content]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =============================================================================
// Session queries
// =============================================================================

/**
 * Fetches a conversation session by agent and session key.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string} sessionKey - Composite key: {userId}-{channelId}-{threadTs|'direct'}.
 * @returns {Promise<Session | null>} The session, or null if not found.
 */
export async function getSession(agentId: string, sessionKey: string): Promise<Session | null> {
  const result = await getPool().query(
    'SELECT * FROM sessions WHERE agent_id = $1 AND session_key = $2',
    [agentId, sessionKey]
  );
  return result.rows.length > 0 ? rowToSession(result.rows[0]) : null;
}

/**
 * Creates or updates a conversation session.
 * Updates last_activity on conflict.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string} sessionKey - Composite session key.
 * @param {string | undefined} claudeSessionId - Claude Code SDK session ID.
 * @returns {Promise<Session>} The upserted session.
 */
export async function upsertSession(
  agentId: string,
  sessionKey: string,
  claudeSessionId?: string
): Promise<Session> {
  const result = await getPool().query(
    `INSERT INTO sessions (agent_id, session_key, claude_session_id, last_activity)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (agent_id, session_key) DO UPDATE
       SET claude_session_id = COALESCE(EXCLUDED.claude_session_id, sessions.claude_session_id),
           last_activity = now()
     RETURNING *`,
    [agentId, sessionKey, claudeSessionId ?? null]
  );
  return rowToSession(result.rows[0]);
}

/**
 * Deletes sessions for an agent that have been inactive for longer than maxAgeMs.
 *
 * @param {string} agentId - Agent UUID.
 * @param {number} maxAgeMs - Maximum session age in milliseconds.
 * @returns {Promise<number>} Number of sessions deleted.
 */
export async function cleanupStaleSessions(agentId: string, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await getPool().query(
    'DELETE FROM sessions WHERE agent_id = $1 AND last_activity < $2',
    [agentId, cutoff]
  );
  return result.rowCount ?? 0;
}

// =============================================================================
// Scheduled Jobs
// =============================================================================

/**
 * Returns all enabled scheduled jobs.
 *
 * @returns {Promise<ScheduledJob[]>}
 */
export async function getAllEnabledJobs(): Promise<ScheduledJob[]> {
  const r = await getPool().query('SELECT * FROM scheduled_jobs WHERE enabled = true');
  return r.rows.map(row => ({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cronSchedule: row.cron_schedule,
    targetType: row.target_type,
    targetId: row.target_id,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Inserts a new job run record with status 'running'.
 *
 * @param {string} jobId - The scheduled job ID.
 * @returns {Promise<string>} The new run ID.
 */
export async function insertJobRun(jobId: string): Promise<string> {
  const r = await getPool().query(
    "INSERT INTO job_runs (job_id, status) VALUES ($1, 'running') RETURNING id",
    [jobId]
  );
  return r.rows[0].id;
}

/**
 * Updates a job run with final status, output, and error.
 *
 * @param {string} runId - The run ID.
 * @param {'success' | 'error'} status - Final status.
 * @param {string | null} output - Truncated output text.
 * @param {string | null} error - Error message if failed.
 */
export async function updateJobRun(
  runId: string,
  status: 'success' | 'error',
  output?: string | null,
  error?: string | null
): Promise<void> {
  await getPool().query(
    'UPDATE job_runs SET status = $1, output = $2, error = $3, finished_at = now() WHERE id = $4',
    [status, output ?? null, error ?? null, runId]
  );
}

// =============================================================================
// Env Vars
// =============================================================================

/**
 * Returns all env vars as a key→value map. Used by the runner to resolve
 * envRefs in MCP stdio configs at agent start time.
 *
 * @returns {Promise<Record<string, string>>}
 */
export async function getAllEnvVarValues(): Promise<Record<string, string>> {
  const encKey = process.env.ENV_SECRET_KEY;
  if (!encKey) {
    logger.warn('ENV_SECRET_KEY not set — env var refs will not resolve');
    return {};
  }
  const r = await getPool().query(
    'SELECT key, pgp_sym_decrypt(value::bytea, $1::text)::text AS value FROM env_vars',
    [encKey],
  );
  return Object.fromEntries(r.rows.map((row: { key: string; value: string }) => [row.key, row.value]));
}
