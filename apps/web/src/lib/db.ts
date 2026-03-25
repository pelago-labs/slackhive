/**
 * @fileoverview PostgreSQL database client for the Next.js web application.
 *
 * Provides a singleton connection pool and typed query functions for
 * all tables managed by the web UI: agents, mcp_servers, agent_mcps,
 * skills, permissions, and memories.
 *
 * Also provides a Redis client for publishing agent lifecycle events
 * to the runner service (hot-reload).
 *
 * @module web/lib/db
 */

import { Pool } from 'pg';
import { createClient } from 'redis';
import type {
  Agent,
  McpServer,
  Skill,
  Permission,
  Memory,
  Session,
  AgentEvent,
  AgentStatus,
  UpsertMcpServerRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
} from '@slack-agent-team/shared';
import { AGENT_EVENTS_CHANNEL } from '@slack-agent-team/shared';

// =============================================================================
// Connection pool
// =============================================================================

let pool: Pool | null = null;

/**
 * Returns the singleton Postgres connection pool for the web app.
 *
 * @returns {Pool} Postgres connection pool.
 * @throws {Error} If DATABASE_URL is not configured.
 */
function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    pool = new Pool({ connectionString: url, max: 5 });
  }
  return pool;
}

// =============================================================================
// Redis publisher
// =============================================================================

let redisPublisher: ReturnType<typeof createClient> | null = null;

/**
 * Returns a connected Redis client for publishing agent events.
 * Lazy-connects on first call.
 *
 * @returns {Promise<ReturnType<typeof createClient>>} Connected Redis client.
 */
async function getRedis(): Promise<ReturnType<typeof createClient>> {
  if (!redisPublisher || !redisPublisher.isOpen) {
    redisPublisher = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
    await redisPublisher.connect();
  }
  return redisPublisher;
}

/**
 * Publishes an agent lifecycle event to the runner via Redis.
 * Used to trigger hot-reload when config changes in the UI.
 *
 * @param {AgentEvent} event - The lifecycle event to publish.
 * @returns {Promise<void>}
 */
export async function publishAgentEvent(event: AgentEvent): Promise<void> {
  const redis = await getRedis();
  await redis.publish(AGENT_EVENTS_CHANNEL, JSON.stringify(event));
}

// =============================================================================
// Row mappers
// =============================================================================

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
    reportsTo: (row.reports_to as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

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

// =============================================================================
// Agent queries
// =============================================================================

/** Returns all agents ordered boss-first. */
export async function getAllAgents(): Promise<Agent[]> {
  const r = await getPool().query('SELECT * FROM agents ORDER BY is_boss DESC, name ASC');
  return r.rows.map(rowToAgent);
}

/** Returns a single agent by ID. */
export async function getAgentById(id: string): Promise<Agent | null> {
  const r = await getPool().query('SELECT * FROM agents WHERE id = $1', [id]);
  return r.rows.length ? rowToAgent(r.rows[0]) : null;
}

/** Returns a single agent by slug. */
export async function getAgentBySlug(slug: string): Promise<Agent | null> {
  const r = await getPool().query('SELECT * FROM agents WHERE slug = $1', [slug]);
  return r.rows.length ? rowToAgent(r.rows[0]) : null;
}

/**
 * Creates a new agent record in the database.
 *
 * @param {CreateAgentRequest} req - Agent creation data.
 * @returns {Promise<Agent>} The created agent.
 */
export async function createAgent(req: CreateAgentRequest): Promise<Agent> {
  const r = await getPool().query(
    `INSERT INTO agents
       (slug, name, persona, description, slack_bot_token, slack_app_token,
        slack_signing_secret, model, is_boss, reports_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      req.slug, req.name, req.persona ?? null, req.description ?? null,
      req.slackBotToken, req.slackAppToken, req.slackSigningSecret,
      req.model ?? 'claude-opus-4-6', req.isBoss ?? false, req.reportsTo ?? null,
    ]
  );
  return rowToAgent(r.rows[0]);
}

/**
 * Updates an agent's status field.
 *
 * @param {string} id - Agent UUID.
 * @param {AgentStatus} status - New status.
 * @returns {Promise<void>}
 */
export async function updateAgentStatus(id: string, status: AgentStatus): Promise<void> {
  await getPool().query(
    'UPDATE agents SET status = $1, updated_at = now() WHERE id = $2',
    [status, id]
  );
}

/**
 * Updates mutable fields on an agent record.
 *
 * @param {string} id - Agent UUID.
 * @param {UpdateAgentRequest} req - Fields to update.
 * @returns {Promise<Agent | null>} The updated agent, or null if not found.
 */
export async function updateAgent(id: string, req: UpdateAgentRequest): Promise<Agent | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (req.name !== undefined) { fields.push(`name = $${idx++}`); values.push(req.name); }
  if (req.persona !== undefined) { fields.push(`persona = $${idx++}`); values.push(req.persona); }
  if (req.description !== undefined) { fields.push(`description = $${idx++}`); values.push(req.description); }
  if (req.slackBotToken !== undefined) { fields.push(`slack_bot_token = $${idx++}`); values.push(req.slackBotToken); }
  if (req.slackAppToken !== undefined) { fields.push(`slack_app_token = $${idx++}`); values.push(req.slackAppToken); }
  if (req.slackSigningSecret !== undefined) { fields.push(`slack_signing_secret = $${idx++}`); values.push(req.slackSigningSecret); }
  if (req.model !== undefined) { fields.push(`model = $${idx++}`); values.push(req.model); }

  if (fields.length === 0) return getAgentById(id);

  fields.push(`updated_at = now()`);
  values.push(id);
  const r = await getPool().query(
    `UPDATE agents SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return r.rows.length ? rowToAgent(r.rows[0]) : null;
}

/**
 * Deletes an agent and all related records (cascades via FK).
 *
 * @param {string} id - Agent UUID.
 * @returns {Promise<void>}
 */
export async function deleteAgent(id: string): Promise<void> {
  await getPool().query('DELETE FROM agents WHERE id = $1', [id]);
}

/**
 * Returns all active sessions for an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Session[]>} Array of sessions.
 */
export async function getAgentSessions(agentId: string): Promise<Session[]> {
  const r = await getPool().query(
    'SELECT * FROM sessions WHERE agent_id = $1 ORDER BY last_activity DESC',
    [agentId]
  );
  return r.rows.map(row => ({
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionKey: row.session_key as string,
    claudeSessionId: row.claude_session_id as string | undefined,
    lastActivity: row.last_activity as Date,
  }));
}

/**
 * Creates or updates a memory entry for an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string} type - Memory type.
 * @param {string} name - Memory name.
 * @param {string} content - Memory markdown content.
 * @returns {Promise<Memory>} The upserted memory.
 */
export async function upsertMemory(
  agentId: string,
  type: string,
  name: string,
  content: string
): Promise<Memory> {
  const r = await getPool().query(
    `INSERT INTO memories (agent_id, type, name, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, name) DO UPDATE
       SET type = EXCLUDED.type, content = EXCLUDED.content, updated_at = now()
     RETURNING *`,
    [agentId, type, name, content]
  );
  return rowToMemory(r.rows[0]);
}

// =============================================================================
// MCP server queries
// =============================================================================

/** Returns all MCP servers in the global catalog. */
export async function getAllMcpServers(): Promise<McpServer[]> {
  const r = await getPool().query('SELECT * FROM mcp_servers ORDER BY name ASC');
  return r.rows.map(rowToMcpServer);
}

/** Returns all MCP servers assigned to an agent. */
export async function getAgentMcpServers(agentId: string): Promise<McpServer[]> {
  const r = await getPool().query(
    `SELECT m.* FROM mcp_servers m
     JOIN agent_mcps am ON am.mcp_id = m.id
     WHERE am.agent_id = $1 ORDER BY m.name`,
    [agentId]
  );
  return r.rows.map(rowToMcpServer);
}

/**
 * Creates a new MCP server in the global catalog.
 *
 * @param {UpsertMcpServerRequest} req - MCP server data.
 * @returns {Promise<McpServer>} The created MCP server.
 */
export async function createMcpServer(req: UpsertMcpServerRequest): Promise<McpServer> {
  const r = await getPool().query(
    `INSERT INTO mcp_servers (name, type, config, description, enabled)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.name, req.type, JSON.stringify(req.config), req.description ?? null, req.enabled ?? true]
  );
  return rowToMcpServer(r.rows[0]);
}

/**
 * Updates an existing MCP server.
 *
 * @param {string} id - MCP server UUID.
 * @param {Partial<UpsertMcpServerRequest>} req - Fields to update.
 * @returns {Promise<McpServer | null>} The updated record, or null if not found.
 */
export async function updateMcpServer(
  id: string,
  req: Partial<UpsertMcpServerRequest>
): Promise<McpServer | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (req.name !== undefined) { fields.push(`name = $${idx++}`); values.push(req.name); }
  if (req.type !== undefined) { fields.push(`type = $${idx++}`); values.push(req.type); }
  if (req.config !== undefined) { fields.push(`config = $${idx++}`); values.push(JSON.stringify(req.config)); }
  if (req.description !== undefined) { fields.push(`description = $${idx++}`); values.push(req.description); }
  if (req.enabled !== undefined) { fields.push(`enabled = $${idx++}`); values.push(req.enabled); }

  if (fields.length === 0) return getMcpServerById(id);

  values.push(id);
  const r = await getPool().query(
    `UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return r.rows.length ? rowToMcpServer(r.rows[0]) : null;
}

/** Returns a single MCP server by ID. */
export async function getMcpServerById(id: string): Promise<McpServer | null> {
  const r = await getPool().query('SELECT * FROM mcp_servers WHERE id = $1', [id]);
  return r.rows.length ? rowToMcpServer(r.rows[0]) : null;
}

/** Deletes a MCP server from the catalog. */
export async function deleteMcpServer(id: string): Promise<void> {
  await getPool().query('DELETE FROM mcp_servers WHERE id = $1', [id]);
}

/** Assigns a set of MCP servers to an agent (replaces all existing assignments). */
export async function setAgentMcps(agentId: string, mcpIds: string[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM agent_mcps WHERE agent_id = $1', [agentId]);
    for (const mcpId of mcpIds) {
      await client.query(
        'INSERT INTO agent_mcps (agent_id, mcp_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [agentId, mcpId]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// =============================================================================
// Skills queries
// =============================================================================

/** Returns all skills for an agent, ordered for CLAUDE.md compilation. */
export async function getAgentSkills(agentId: string): Promise<Skill[]> {
  const r = await getPool().query(
    'SELECT * FROM skills WHERE agent_id = $1 ORDER BY category, sort_order, filename',
    [agentId]
  );
  return r.rows.map(rowToSkill);
}

/** Creates or updates a skill file. */
export async function upsertSkill(
  agentId: string,
  category: string,
  filename: string,
  content: string,
  sortOrder = 0
): Promise<Skill> {
  const r = await getPool().query(
    `INSERT INTO skills (agent_id, category, filename, content, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id, category, filename)
     DO UPDATE SET content = EXCLUDED.content, sort_order = EXCLUDED.sort_order, updated_at = now()
     RETURNING *`,
    [agentId, category, filename, content, sortOrder]
  );
  return rowToSkill(r.rows[0]);
}

/** Deletes a skill file. */
export async function deleteSkill(id: string): Promise<void> {
  await getPool().query('DELETE FROM skills WHERE id = $1', [id]);
}

/** Deletes all skills for an agent. */
export async function deleteSkillsByAgent(agentId: string): Promise<void> {
  await getPool().query('DELETE FROM skills WHERE agent_id = $1', [agentId]);
}

// =============================================================================
// Permissions queries
// =============================================================================

/** Returns tool permissions for an agent. */
export async function getAgentPermissions(agentId: string): Promise<Permission | null> {
  const r = await getPool().query('SELECT * FROM permissions WHERE agent_id = $1', [agentId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    agentId: row.agent_id,
    allowedTools: row.allowed_tools,
    deniedTools: row.denied_tools,
    updatedAt: row.updated_at,
  };
}

/** Creates or replaces tool permissions for an agent. */
export async function upsertPermissions(
  agentId: string,
  allowedTools: string[],
  deniedTools: string[]
): Promise<void> {
  await getPool().query(
    `INSERT INTO permissions (agent_id, allowed_tools, denied_tools)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id)
     DO UPDATE SET allowed_tools = $2, denied_tools = $3, updated_at = now()`,
    [agentId, allowedTools, deniedTools]
  );
}

// =============================================================================
// Memory queries
// =============================================================================

/** Returns all memories for an agent. */
export async function getAgentMemories(agentId: string): Promise<Memory[]> {
  const r = await getPool().query(
    'SELECT * FROM memories WHERE agent_id = $1 ORDER BY type, created_at',
    [agentId]
  );
  return r.rows.map(rowToMemory);
}

/** Deletes a specific memory entry. */
export async function deleteMemory(id: string): Promise<void> {
  await getPool().query('DELETE FROM memories WHERE id = $1', [id]);
}

// =============================================================================
// Settings queries
// =============================================================================

/**
 * Returns a single setting value by key.
 *
 * @param {string} key - The setting key to look up.
 * @returns {Promise<string | null>} The value, or null if not set.
 */
export async function getSetting(key: string): Promise<string | null> {
  const r = await getPool().query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows.length ? (r.rows[0].value as string) : null;
}

/**
 * Creates or updates a single setting.
 *
 * @param {string} key - The setting key.
 * @param {string} value - The setting value.
 * @returns {Promise<void>}
 */
export async function setSetting(key: string, value: string): Promise<void> {
  await getPool().query(
    `INSERT INTO settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

/**
 * Returns all settings as a flat key-value map.
 *
 * @returns {Promise<Record<string, string>>} All stored settings.
 */
export async function getAllSettings(): Promise<Record<string, string>> {
  const r = await getPool().query('SELECT key, value FROM settings ORDER BY key');
  const result: Record<string, string> = {};
  for (const row of r.rows) {
    result[row.key as string] = row.value as string;
  }
  return result;
}

// =============================================================================
// User queries
// =============================================================================

/**
 * Returns a user by username including password hash (for auth).
 *
 * @param {string} username - The username to look up.
 * @returns {Promise<{ id: string; username: string; passwordHash: string; role: string; createdAt: string } | null>}
 */
export async function getUserByUsername(username: string): Promise<{ id: string; username: string; passwordHash: string; role: string; createdAt: string } | null> {
  const r = await getPool().query(
    'SELECT id, username, password_hash, role, created_at FROM users WHERE username = $1',
    [username]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role, createdAt: row.created_at };
}

/**
 * Returns all users (without password hashes).
 *
 * @returns {Promise<Array<{ id: string; username: string; role: string; createdAt: string }>>}
 */
export async function getAllUsers(): Promise<Array<{ id: string; username: string; role: string; createdAt: string }>> {
  const r = await getPool().query('SELECT id, username, role, created_at FROM users ORDER BY created_at');
  return r.rows.map(row => ({ id: row.id, username: row.username, role: row.role, createdAt: row.created_at }));
}

/**
 * Creates a new user.
 *
 * @param {string} username - Unique username.
 * @param {string} passwordHash - Bcrypt hash.
 * @param {string} role - 'admin' or 'viewer'.
 * @returns {Promise<{ id: string; username: string; role: string }>}
 */
export async function createUser(username: string, passwordHash: string, role: string): Promise<{ id: string; username: string; role: string }> {
  const r = await getPool().query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
    [username, passwordHash, role]
  );
  return r.rows[0];
}

/**
 * Deletes a user by ID.
 *
 * @param {string} id - User UUID.
 */
export async function deleteUser(id: string): Promise<void> {
  await getPool().query('DELETE FROM users WHERE id = $1', [id]);
}
