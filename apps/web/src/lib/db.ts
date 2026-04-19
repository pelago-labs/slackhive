/**
 * @fileoverview Database client for the Next.js web application.
 *
 * Uses the shared DbAdapter to support both PostgreSQL and SQLite.
 * Provides typed query functions for all tables managed by the web UI.
 * Uses the shared EventBus for publishing agent lifecycle events.
 *
 * @module web/lib/db
 */

import { randomUUID } from 'crypto';
import type {
  Agent,
  McpServer,
  Skill,
  Permission,
  Memory,
  Session,
  ScheduledJob,
  JobRun,
  CreateJobRequest,
  UpdateJobRequest,
  AgentEvent,
  AgentStatus,
  UpsertMcpServerRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
  AgentSnapshot,
  SnapshotSkill,
  SnapshotTrigger,
  Restriction,
} from '@slackhive/shared';
import { getDb, initDb, encrypt, decrypt } from '@slackhive/shared';
import type { DbAdapter } from '@slackhive/shared';

// =============================================================================
// Database & Event Bus
// =============================================================================

let _dbInitialized = false;

/**
 * Returns the database adapter, initializing on first call.
 * Supports both PostgreSQL and SQLite based on DATABASE_TYPE env.
 */
async function db(): Promise<DbAdapter> {
  if (!_dbInitialized) {
    await initDb();
    _dbInitialized = true;
  }
  return getDb();
}

/**
 * Publishes an agent lifecycle event to the runner via internal HTTP server.
 *
 * @param {AgentEvent} event - The lifecycle event to publish.
 * @returns {Promise<void>}
 */
export async function publishAgentEvent(event: AgentEvent): Promise<void> {
  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {
    // Runner might not be running — silently ignore
  }
}

// =============================================================================
// Row mappers
// =============================================================================

/**
 * Maps a raw DB row to an {@link Agent} interface.
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
    model: row.model as string,
    status: row.status as AgentStatus,
    enabled: row.enabled !== false,
    isBoss: row.is_boss as boolean,
    verbose: row.verbose !== 0 && row.verbose !== false,
    reportsTo: (row.reports_to as string[]) ?? [],
    claudeMd: (row.claude_md as string) ?? '',
    createdBy: (row.created_by as string) ?? 'system',
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lastError: (row.last_error as string | null | undefined) ?? null,
  };
}

/** Enrich agent with platform credentials from platform_integrations table. */
async function enrichAgentWithPlatform(agent: Agent | null): Promise<Agent | null> {
  if (!agent) return null;
  const d = await db();
  const r = await d.query(
    'SELECT credentials, bot_user_id FROM platform_integrations WHERE agent_id = $1 AND platform = $2 AND enabled = 1',
    [agent.id, 'slack']
  );
  if (r.rows.length > 0) {
    const raw = r.rows[0].credentials as string;
    const key = process.env.ENV_SECRET_KEY ?? process.env.AUTH_SECRET ?? 'slackhive-default-key';
    let creds: Record<string, string> | null = null;
    try {
      creds = JSON.parse(decrypt(raw, key));
    } catch {
      try { creds = JSON.parse(raw); } catch { /* not parseable */ }
    }
    if (creds) {
      agent.slackBotToken = creds.botToken;
      agent.slackAppToken = creds.appToken;
      agent.slackSigningSecret = creds.signingSecret;
      agent.slackBotUserId = r.rows[0].bot_user_id as string | undefined;
    }
  }
  return agent;
}

/**
 * Maps a raw DB row to a {@link McpServer} interface.
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
 * Maps a raw DB row to a {@link Skill} interface.
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
 * Maps a raw DB row to a {@link Memory} interface.
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

// =============================================================================
// Agent queries
// =============================================================================

/**
 * Returns all agents ordered boss-first, then alphabetically by name.
 *
 * @returns {Promise<Agent[]>} All registered agents.
 */
export async function getAllAgents(): Promise<Agent[]> {
  const d = await db();
  const r = await d.query('SELECT * FROM agents ORDER BY is_boss DESC, name ASC');
  const agents = r.rows.map(rowToAgent);

  // Bulk load platform credentials for all agents
  const pi = await d.query('SELECT agent_id, credentials, bot_user_id FROM platform_integrations WHERE platform = $1 AND enabled = 1', ['slack']);
  const credsByAgent = new Map<string, { credentials: string; botUserId?: string }>();
  for (const row of pi.rows) {
    credsByAgent.set(row.agent_id as string, { credentials: row.credentials as string, botUserId: row.bot_user_id as string | undefined });
  }

  const key = process.env.ENV_SECRET_KEY ?? process.env.AUTH_SECRET ?? 'slackhive-default-key';
  for (const agent of agents) {
    const entry = credsByAgent.get(agent.id);
    if (entry) {
      let creds: Record<string, string> | null = null;
      try { creds = JSON.parse(decrypt(entry.credentials, key)); } catch {
        try { creds = JSON.parse(entry.credentials); } catch { /* skip */ }
      }
      if (creds) {
        agent.slackBotToken = creds.botToken;
        agent.slackAppToken = creds.appToken;
        agent.slackSigningSecret = creds.signingSecret;
        agent.slackBotUserId = entry.botUserId;
      }
    }
  }

  return agents;
}

/**
 * Returns a single agent by UUID.
 *
 * @param {string} id - Agent UUID.
 * @returns {Promise<Agent | null>} The agent, or null if not found.
 */
export async function getAgentById(id: string): Promise<Agent | null> {
  const r = await (await db()).query('SELECT * FROM agents WHERE id = $1', [id]);
  return enrichAgentWithPlatform(r.rows.length ? rowToAgent(r.rows[0]) : null);
}

/**
 * Returns a single agent by its URL-safe slug.
 *
 * @param {string} slug - Agent slug (e.g. `data-analyst`).
 * @returns {Promise<Agent | null>} The agent, or null if not found.
 */
export async function getAgentBySlug(slug: string): Promise<Agent | null> {
  const r = await (await db()).query('SELECT * FROM agents WHERE slug = $1', [slug]);
  return enrichAgentWithPlatform(r.rows.length ? rowToAgent(r.rows[0]) : null);
}

/**
 * Creates a new agent record in the database.
 *
 * @param {CreateAgentRequest} req - Agent creation data.
 * @returns {Promise<Agent>} The created agent.
 */
export async function createAgent(req: CreateAgentRequest, createdBy = 'system'): Promise<Agent> {
  const id = randomUUID();
  const d = await db();
  const r = await d.query(
    `INSERT INTO agents
       (id, slug, name, persona, description, model, is_boss, reports_to, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      id, req.slug, req.name, req.persona ?? null, req.description ?? null,
      req.model ?? 'claude-opus-4-6', req.isBoss ?? false, req.reportsTo ?? [],
      createdBy,
    ]
  );

  // Create platform integration if credentials provided
  if (req.platformCredentials && req.platform) {
    const { encrypt } = await import('@slackhive/shared');
    await d.query(
      `INSERT INTO platform_integrations (id, agent_id, platform, credentials)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), id, req.platform, encrypt(JSON.stringify(req.platformCredentials), process.env.ENV_SECRET_KEY ?? process.env.AUTH_SECRET ?? 'slackhive-default-key')]
    );
  }

  const agent = rowToAgent(r.rows[0]);
  return (await enrichAgentWithPlatform(agent))!;
}

/**
 * Updates an agent's status field.
 *
 * @param {string} id - Agent UUID.
 * @param {AgentStatus} status - New status.
 * @returns {Promise<void>}
 */
export async function updateAgentStatus(id: string, status: AgentStatus): Promise<void> {
  // Stopping the agent is an explicit user action — clear any stale last_error
  // so the UI doesn't keep showing an old failure message under a 'stopped' chip.
  if (status === 'stopped') {
    await (await db()).query(
      'UPDATE agents SET status = $1, last_error = NULL, updated_at = now() WHERE id = $2',
      [status, id]
    );
  } else {
    await (await db()).query(
      'UPDATE agents SET status = $1, updated_at = now() WHERE id = $2',
      [status, id]
    );
  }
}

export async function updateAgentEnabled(id: string, enabled: boolean): Promise<void> {
  await (await db()).query(
    'UPDATE agents SET enabled = $1, updated_at = now() WHERE id = $2',
    [enabled, id]
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
  if (req.model !== undefined) { fields.push(`model = $${idx++}`); values.push(req.model); }
  if (req.isBoss !== undefined) { fields.push(`is_boss = $${idx++}`); values.push(req.isBoss); }
  if (req.reportsTo !== undefined) { fields.push(`reports_to = $${idx++}`); values.push(req.reportsTo); }
  if (req.verbose !== undefined) { fields.push(`verbose = $${idx++}`); values.push(req.verbose); }

  // Upsert platform credentials if provided
  if (req.platformCredentials) {
    const { encrypt } = await import('@slackhive/shared');
    const d = await db();
    const encrypted = encrypt(JSON.stringify(req.platformCredentials), process.env.ENV_SECRET_KEY ?? process.env.AUTH_SECRET ?? 'slackhive-default-key');

    // Check if integration row exists
    const existing = await d.query(
      `SELECT id FROM platform_integrations WHERE agent_id = $1 AND platform = 'slack'`,
      [id]
    );

    if (existing.rows.length > 0) {
      await d.query(
        `UPDATE platform_integrations SET credentials = $1 WHERE agent_id = $2 AND platform = 'slack'`,
        [encrypted, id]
      );
    } else {
      await d.query(
        `INSERT INTO platform_integrations (id, agent_id, platform, credentials)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), id, 'slack', encrypted]
      );
    }
  }

  if (fields.length === 0) return getAgentById(id);

  fields.push(`updated_at = now()`);
  values.push(id);
  const r = await (await db()).query(
    `UPDATE agents SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return r.rows.length ? rowToAgent(r.rows[0]) : null;
}

/**
 * Replaces the CLAUDE.md content for an agent.
 * This is the main instruction/identity file, separate from skills.
 *
 * @param {string} id - Agent UUID.
 * @param {string} content - New CLAUDE.md content.
 * @returns {Promise<void>}
 */
export async function updateAgentClaudeMd(id: string, content: string): Promise<void> {
  await (await db()).query(
    'UPDATE agents SET claude_md = $1, updated_at = now() WHERE id = $2',
    [content, id]
  );
}

/**
 * Deletes an agent and all related records (cascades via FK).
 *
 * @param {string} id - Agent UUID.
 * @returns {Promise<void>}
 */
export async function deleteAgent(id: string): Promise<void> {
  await (await db()).query('DELETE FROM agents WHERE id = $1', [id]);
}

/**
 * Returns all active sessions for an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Session[]>} Array of sessions.
 */
export async function getAgentSessions(agentId: string): Promise<Session[]> {
  const r = await (await db()).query(
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
  const id = randomUUID();
  const r = await (await db()).query(
    `INSERT INTO memories (id, agent_id, type, name, content)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id, name) DO UPDATE
       SET type = EXCLUDED.type, content = EXCLUDED.content, updated_at = now()
     RETURNING *`,
    [id, agentId, type, name, content]
  );
  return rowToMemory(r.rows[0]);
}

// =============================================================================
// MCP server queries
// =============================================================================

/**
 * Returns all MCP servers in the global catalog, ordered by name.
 *
 * @returns {Promise<McpServer[]>} All registered MCP servers.
 */
export async function getAllMcpServers(): Promise<McpServer[]> {
  const r = await (await db()).query('SELECT * FROM mcp_servers ORDER BY name ASC');
  return r.rows.map(rowToMcpServer);
}

/**
 * Returns all MCP servers currently assigned to an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<McpServer[]>} MCP servers assigned to this agent.
 */
export async function getAgentMcpServers(agentId: string): Promise<McpServer[]> {
  const r = await (await db()).query(
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
  const id = randomUUID();
  const r = await (await db()).query(
    `INSERT INTO mcp_servers (id, name, type, config, description, enabled)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, req.name, req.type, JSON.stringify(req.config), req.description ?? null, req.enabled ?? true]
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
  const r = await (await db()).query(
    `UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return r.rows.length ? rowToMcpServer(r.rows[0]) : null;
}

/**
 * Returns a single MCP server by UUID.
 *
 * @param {string} id - MCP server UUID.
 * @returns {Promise<McpServer | null>} The server, or null if not found.
 */
export async function getMcpServerById(id: string): Promise<McpServer | null> {
  const r = await (await db()).query('SELECT * FROM mcp_servers WHERE id = $1', [id]);
  return r.rows.length ? rowToMcpServer(r.rows[0]) : null;
}

/**
 * Deletes an MCP server from the global catalog.
 * Any agent_mcps assignments are removed via CASCADE.
 *
 * @param {string} id - MCP server UUID.
 * @returns {Promise<void>}
 */
export async function deleteMcpServer(id: string): Promise<void> {
  await (await db()).query('DELETE FROM mcp_servers WHERE id = $1', [id]);
}

/**
 * Atomically replaces all MCP server assignments for an agent.
 * Deletes existing assignments and inserts the new set in a single transaction.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string[]} mcpIds - UUIDs of MCP servers to assign.
 * @returns {Promise<void>}
 * @throws {Error} If the transaction fails; changes are rolled back automatically.
 */
export async function setAgentMcps(agentId: string, mcpIds: string[]): Promise<void> {
  const adapter = await db();
  await adapter.transaction(async (tx) => {
    await tx.query('DELETE FROM agent_mcps WHERE agent_id = $1', [agentId]);
    for (const mcpId of mcpIds) {
      await tx.query(
        'INSERT INTO agent_mcps (agent_id, mcp_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [agentId, mcpId]
      );
    }
  });
}

// =============================================================================
// Skills queries
// =============================================================================

/**
 * Returns all skills for an agent ordered for CLAUDE.md compilation:
 * category ASC → sort_order ASC → filename ASC.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Skill[]>} Ordered skill files.
 */
export async function getAgentSkills(agentId: string): Promise<Skill[]> {
  const r = await (await db()).query(
    'SELECT * FROM skills WHERE agent_id = $1 ORDER BY category, sort_order, filename',
    [agentId]
  );
  return r.rows.map(rowToSkill);
}

/**
 * Creates or updates a skill file for an agent.
 * Conflicts on (agent_id, category, filename) update content and sort_order.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string} category - Skill category directory (e.g. `'00-core'`).
 * @param {string} filename - Skill filename (e.g. `'main.md'`).
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
  const id = randomUUID();
  const r = await (await db()).query(
    `INSERT INTO skills (id, agent_id, category, filename, content, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (agent_id, category, filename)
     DO UPDATE SET content = EXCLUDED.content, sort_order = EXCLUDED.sort_order, updated_at = now()
     RETURNING *`,
    [id, agentId, category, filename, content, sortOrder]
  );
  return rowToSkill(r.rows[0]);
}

/**
 * Deletes a single skill by UUID.
 *
 * @param {string} id - Skill UUID.
 * @returns {Promise<void>}
 */
export async function deleteSkill(id: string): Promise<void> {
  await (await db()).query('DELETE FROM skills WHERE id = $1', [id]);
}

/**
 * Deletes all skill files for an agent. Used when replacing skills wholesale.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<void>}
 */
export async function deleteSkillsByAgent(agentId: string): Promise<void> {
  await (await db()).query('DELETE FROM skills WHERE agent_id = $1', [agentId]);
}

// =============================================================================
// Permissions queries
// =============================================================================

/**
 * Returns the tool allow/deny permissions for an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Permission | null>} The permission record, or null if not configured.
 */
export async function getAgentPermissions(agentId: string): Promise<Permission | null> {
  const r = await (await db()).query('SELECT * FROM permissions WHERE agent_id = $1', [agentId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    allowedTools: row.allowed_tools as string[],
    deniedTools: row.denied_tools as string[],
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Creates or replaces tool permissions for an agent.
 * Conflicts on agent_id update both arrays in place.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string[]} allowedTools - Tools the agent is allowed to use.
 * @param {string[]} deniedTools - Tools explicitly blocked for this agent.
 * @returns {Promise<void>}
 */
export async function upsertPermissions(
  agentId: string,
  allowedTools: string[],
  deniedTools: string[]
): Promise<void> {
  const id = randomUUID();
  await (await db()).query(
    `INSERT INTO permissions (id, agent_id, allowed_tools, denied_tools)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id)
     DO UPDATE SET allowed_tools = $3, denied_tools = $4, updated_at = now()`,
    [id, agentId, allowedTools, deniedTools]
  );
}

// =============================================================================
// Restrictions queries
// =============================================================================

/**
 * Returns the channel restrictions for an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Restriction | null>} The restriction record, or null if not configured.
 */
export async function getAgentRestrictions(agentId: string): Promise<Restriction | null> {
  const r = await (await db()).query('SELECT * FROM agent_restrictions WHERE agent_id = $1', [agentId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    allowedChannels: (row.allowed_channels as string[]) ?? [],
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Creates or replaces channel restrictions for an agent.
 *
 * @param {string} agentId - Agent UUID.
 * @param {string[]} allowedChannels - Channel IDs the bot is allowed to respond in.
 * @returns {Promise<void>}
 */
export async function upsertRestrictions(
  agentId: string,
  allowedChannels: string[],
): Promise<void> {
  const id = randomUUID();
  await (await db()).query(
    `INSERT INTO agent_restrictions (id, agent_id, allowed_channels)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id)
     DO UPDATE SET allowed_channels = $3, updated_at = now()`,
    [id, agentId, allowedChannels]
  );
}

// =============================================================================
// Memory queries
// =============================================================================

/**
 * Returns all memory entries for an agent, ordered by type then creation time.
 *
 * @param {string} agentId - Agent UUID.
 * @returns {Promise<Memory[]>} All memory entries for this agent.
 */
export async function getAgentMemories(agentId: string): Promise<Memory[]> {
  const r = await (await db()).query(
    'SELECT * FROM memories WHERE agent_id = $1 ORDER BY type, created_at',
    [agentId]
  );
  return r.rows.map(rowToMemory);
}

/**
 * Deletes a memory entry by UUID.
 *
 * @param {string} id - Memory UUID.
 * @returns {Promise<void>}
 */
export async function deleteMemory(id: string): Promise<void> {
  await (await db()).query('DELETE FROM memories WHERE id = $1', [id]);
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
  const r = await (await db()).query('SELECT value FROM settings WHERE key = $1', [key]);
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
  await (await db()).query(
    `INSERT INTO settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

/**
 * Deletes a single setting by key. No-op if the key is absent.
 *
 * @param {string} key - The setting key to remove.
 * @returns {Promise<void>}
 */
export async function deleteSetting(key: string): Promise<void> {
  await (await db()).query('DELETE FROM settings WHERE key = $1', [key]);
}

/**
 * Returns all settings as a flat key-value map.
 *
 * @returns {Promise<Record<string, string>>} All stored settings.
 */
export async function getAllSettings(): Promise<Record<string, string>> {
  const r = await (await db()).query('SELECT key, value FROM settings ORDER BY key');
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
  const r = await (await db()).query(
    'SELECT id, username, password_hash, role, created_at FROM users WHERE username = $1',
    [username]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { id: row.id as string, username: row.username as string, passwordHash: row.password_hash as string, role: row.role as string, createdAt: row.created_at as string };
}

/**
 * Returns all users (without password hashes).
 *
 * @returns {Promise<Array<{ id: string; username: string; role: string; createdAt: string }>>}
 */
export async function getAllUsers(): Promise<Array<{ id: string; username: string; role: string; createdAt: string }>> {
  const r = await (await db()).query('SELECT id, username, role, created_at FROM users ORDER BY created_at');
  return r.rows.map(row => ({ id: row.id as string, username: row.username as string, role: row.role as string, createdAt: row.created_at as string }));
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
  const id = randomUUID();
  const r = await (await db()).query(
    'INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, role',
    [id, username, passwordHash, role]
  );
  const row = r.rows[0];
  return { id: row.id as string, username: row.username as string, role: row.role as string };
}

/**
 * Deletes a user by ID.
 *
 * @param {string} id - User UUID.
 */
export async function deleteUser(id: string): Promise<void> {
  await (await db()).query('DELETE FROM users WHERE id = $1', [id]);
}

/**
 * Updates a user's role.
 *
 * @param {string} id - User UUID.
 * @param {string} role - New role (admin | editor | viewer).
 * @returns {Promise<void>}
 */
export async function updateUserRole(id: string, role: string): Promise<void> {
  await (await db()).query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
}

// =============================================================================
// Agent access control
// =============================================================================

/**
 * Returns the list of user IDs that have explicit write access to an agent.
 */
export async function getAgentWriteUsers(agentId: string): Promise<{ userId: string; username: string }[]> {
  const r = await (await db()).query(
    `SELECT aa.user_id, u.username
     FROM agent_access aa
     JOIN users u ON u.id = aa.user_id
     WHERE aa.agent_id = $1
     ORDER BY u.username`,
    [agentId]
  );
  return r.rows.map(row => ({ userId: row.user_id as string, username: row.username as string }));
}

/**
 * Grants write access to a user for an agent.
 */
export async function grantAgentWrite(agentId: string, userId: string): Promise<void> {
  await (await db()).query(
    'INSERT INTO agent_access (agent_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [agentId, userId]
  );
}

/**
 * Revokes write access from a user for an agent.
 */
export async function revokeAgentWrite(agentId: string, userId: string): Promise<void> {
  await (await db()).query('DELETE FROM agent_access WHERE agent_id = $1 AND user_id = $2', [agentId, userId]);
}

/**
 * Returns true if a user has write access to an agent.
 * Write access = admin/superadmin role, OR own created agent, OR explicit grant.
 */
export async function userCanWriteAgent(agentId: string, username: string, role: string): Promise<boolean> {
  if (role === 'admin' || role === 'superadmin') return true;
  // Check if creator or explicitly granted
  const r = await (await db()).query(
    `SELECT 1 FROM agents WHERE id = $1 AND created_by = $2
     UNION
     SELECT 1 FROM agent_access aa JOIN users u ON u.id = aa.user_id
       WHERE aa.agent_id = $1 AND u.username = $2
     LIMIT 1`,
    [agentId, username]
  );
  return r.rows.length > 0;
}

// =============================================================================
// Scheduled Jobs
// =============================================================================

/**
 * Maps a DB row to a ScheduledJob object.
 */
function rowToJob(row: Record<string, unknown>): ScheduledJob {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    cronSchedule: row.cron_schedule as string,
    targetType: row.target_type as 'channel' | 'dm',
    targetId: row.target_id as string,
    enabled: row.enabled as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Maps a DB row to a JobRun object.
 */
function rowToJobRun(row: Record<string, unknown>): JobRun {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    startedAt: row.started_at as Date,
    finishedAt: (row.finished_at as Date) ?? undefined,
    status: row.status as 'running' | 'success' | 'error',
    output: (row.output as string) ?? undefined,
    error: (row.error as string) ?? undefined,
  };
}

/**
 * Returns all scheduled jobs with their most recent run info.
 *
 * @returns {Promise<Array<ScheduledJob & { lastRun?: JobRun }>>}
 */
export async function getAllJobs(): Promise<Array<ScheduledJob & { lastRun?: JobRun }>> {
  const adapter = await db();

  if (adapter.type === 'sqlite') {
    // SQLite does not support LATERAL joins — use a correlated subquery instead
    const r = await adapter.query(`
      SELECT j.*,
             lr.id AS lr_id, lr.started_at AS lr_started_at, lr.finished_at AS lr_finished_at,
             lr.status AS lr_status, lr.output AS lr_output, lr.error AS lr_error
      FROM scheduled_jobs j
      LEFT JOIN job_runs lr ON lr.id = (
        SELECT jr.id FROM job_runs jr WHERE jr.job_id = j.id ORDER BY jr.started_at DESC LIMIT 1
      )
      ORDER BY j.created_at DESC
    `);
    return r.rows.map(row => ({
      ...rowToJob(row),
      lastRun: row.lr_id ? {
        id: row.lr_id as string, jobId: row.id as string,
        startedAt: row.lr_started_at as Date, finishedAt: (row.lr_finished_at as Date | null) ?? undefined,
        status: row.lr_status as JobRun['status'], output: (row.lr_output as string | null) ?? undefined, error: (row.lr_error as string | null) ?? undefined,
      } : undefined,
    }));
  }

  // Postgres — use LATERAL for best performance
  const r = await adapter.query(`
    SELECT j.*,
           lr.id AS lr_id, lr.started_at AS lr_started_at, lr.finished_at AS lr_finished_at,
           lr.status AS lr_status, lr.output AS lr_output, lr.error AS lr_error
    FROM scheduled_jobs j
    LEFT JOIN LATERAL (
      SELECT * FROM job_runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1
    ) lr ON true
    ORDER BY j.created_at DESC
  `);
  return r.rows.map(row => ({
    ...rowToJob(row),
    lastRun: row.lr_id ? {
      id: row.lr_id as string, jobId: row.id as string,
      startedAt: row.lr_started_at as Date, finishedAt: (row.lr_finished_at as Date | null) ?? undefined,
      status: row.lr_status as JobRun['status'], output: (row.lr_output as string | null) ?? undefined, error: (row.lr_error as string | null) ?? undefined,
    } : undefined,
  }));
}

/**
 * Returns a single job by ID.
 *
 * @param {string} id - Job UUID.
 * @returns {Promise<ScheduledJob | null>}
 */
export async function getJobById(id: string): Promise<ScheduledJob | null> {
  const r = await (await db()).query('SELECT * FROM scheduled_jobs WHERE id = $1', [id]);
  return r.rows.length ? rowToJob(r.rows[0]) : null;
}

/**
 * Creates a new scheduled job.
 *
 * @param {CreateJobRequest} req - Job creation payload.
 * @returns {Promise<ScheduledJob>}
 */
export async function createJob(req: CreateJobRequest): Promise<ScheduledJob> {
  const id = randomUUID();
  const r = await (await db()).query(
    `INSERT INTO scheduled_jobs (id, agent_id, name, prompt, cron_schedule, target_type, target_id, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [id, req.agentId, req.name, req.prompt, req.cronSchedule, req.targetType ?? 'channel', req.targetId, req.enabled ?? true]
  );
  return rowToJob(r.rows[0]);
}

/**
 * Updates an existing scheduled job.
 *
 * @param {string} id - Job UUID.
 * @param {UpdateJobRequest} req - Fields to update.
 * @returns {Promise<ScheduledJob | null>}
 */
export async function updateJob(id: string, req: UpdateJobRequest): Promise<ScheduledJob | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (req.agentId !== undefined) { sets.push(`agent_id = $${i++}`); vals.push(req.agentId); }
  if (req.name !== undefined) { sets.push(`name = $${i++}`); vals.push(req.name); }
  if (req.prompt !== undefined) { sets.push(`prompt = $${i++}`); vals.push(req.prompt); }
  if (req.cronSchedule !== undefined) { sets.push(`cron_schedule = $${i++}`); vals.push(req.cronSchedule); }
  if (req.targetType !== undefined) { sets.push(`target_type = $${i++}`); vals.push(req.targetType); }
  if (req.targetId !== undefined) { sets.push(`target_id = $${i++}`); vals.push(req.targetId); }
  if (req.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(req.enabled); }
  if (!sets.length) return getJobById(id);
  sets.push(`updated_at = now()`);
  vals.push(id);
  const r = await (await db()).query(
    `UPDATE scheduled_jobs SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );
  return r.rows.length ? rowToJob(r.rows[0]) : null;
}

/**
 * Deletes a scheduled job and all its runs (CASCADE).
 *
 * @param {string} id - Job UUID.
 */
export async function deleteJob(id: string): Promise<void> {
  await (await db()).query('DELETE FROM scheduled_jobs WHERE id = $1', [id]);
}

/**
 * Returns paginated run history for a job.
 *
 * @param {string} jobId - Job UUID.
 * @param {number} limit - Max results.
 * @param {number} offset - Offset.
 * @returns {Promise<JobRun[]>}
 */
export async function getJobRuns(jobId: string, limit = 20, offset = 0): Promise<JobRun[]> {
  const r = await (await db()).query(
    'SELECT * FROM job_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT $2 OFFSET $3',
    [jobId, limit, offset]
  );
  return r.rows.map(rowToJobRun);
}

// =============================================================================
// Agent Snapshots — version control
// =============================================================================

/**
 * Maps a raw DB row to an {@link AgentSnapshot}.
 *
 * @param {Record<string, unknown>} row - Raw row from agent_snapshots.
 * @returns {AgentSnapshot}
 */
function rowToSnapshot(row: Record<string, unknown>): AgentSnapshot {
  return {
    id:           row.id as string,
    agentId:      row.agent_id as string,
    label:        row.label as string | undefined,
    trigger:      row.trigger as SnapshotTrigger,
    createdBy:    row.created_by as string,
    skillsJson:   (row.skills_json as SnapshotSkill[]) ?? [],
    allowedTools: (row.allowed_tools as string[]) ?? [],
    deniedTools:  (row.denied_tools as string[]) ?? [],
    mcpIds:          (row.mcp_ids as string[]) ?? [],
    compiledMd:      row.compiled_md as string,
    allowedChannels: (row.allowed_channels as string[]) ?? [],
    createdAt:       row.created_at as Date,
  };
}

/**
 * Creates a new snapshot for an agent.
 *
 * Auto-snapshots (trigger !== 'manual') are capped at 10 per agent —
 * the oldest ones beyond that cap are purged in the same transaction.
 * Manual snapshots are never auto-purged.
 *
 * @param {string} agentId - Agent UUID.
 * @param {SnapshotTrigger} trigger - What caused this snapshot.
 * @param {string} createdBy - Username of the person who triggered the change.
 * @param {string | null} label - Optional label (used for manual snapshots).
 * @param {SnapshotSkill[]} skills - Skills array at snapshot time.
 * @param {string[]} allowedTools - Allowed tools at snapshot time.
 * @param {string[]} deniedTools - Denied tools at snapshot time.
 * @param {string[]} mcpIds - MCP server UUIDs at snapshot time.
 * @param {string} compiledMd - Skills-only compiled CLAUDE.md.
 * @returns {Promise<AgentSnapshot>} The created snapshot.
 */
export async function createSnapshot(
  agentId: string,
  trigger: SnapshotTrigger,
  createdBy: string,
  label: string | null,
  skills: SnapshotSkill[],
  allowedTools: string[],
  deniedTools: string[],
  mcpIds: string[],
  compiledMd: string,
  allowedChannels: string[] = [],
): Promise<AgentSnapshot> {
  const id = (await import('crypto')).randomUUID();
  const adapter = await db();
  return adapter.transaction(async (tx) => {
    const insertResult = await tx.query(
      `INSERT INTO agent_snapshots
         (id, agent_id, label, trigger, created_by, skills_json,
          allowed_tools, denied_tools, mcp_ids, compiled_md, allowed_channels)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [id, agentId, label, trigger, createdBy, JSON.stringify(skills),
       allowedTools, deniedTools, mcpIds, compiledMd, allowedChannels]
    );

    // Purge oldest auto-snapshots beyond cap=10 for this agent
    await tx.query(
      `DELETE FROM agent_snapshots
       WHERE id IN (
         SELECT id FROM agent_snapshots
         WHERE agent_id = $1 AND trigger != 'manual'
         ORDER BY created_at DESC
         LIMIT -1 OFFSET 10
       )`,
      [agentId]
    );

    return rowToSnapshot(insertResult.rows[0]);
  });
}

/**
 * Returns snapshots for an agent, newest first.
 *
 * @param {string} agentId - Agent UUID.
 * @param {number} limit - Max results (default 100).
 * @param {number} offset - Offset for pagination (default 0).
 * @returns {Promise<AgentSnapshot[]>}
 */
export async function listSnapshots(agentId: string, limit = 100, offset = 0): Promise<AgentSnapshot[]> {
  const r = await (await db()).query(
    `SELECT id, agent_id, trigger, created_by, label, allowed_tools, denied_tools, mcp_ids, allowed_channels, created_at
     FROM agent_snapshots WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [agentId, limit, offset]
  );
  return r.rows.map(row => rowToSnapshot({ ...row, skills_json: [], compiled_md: '' }));
}

/**
 * Returns a single snapshot by UUID.
 *
 * @param {string} id - Snapshot UUID.
 * @returns {Promise<AgentSnapshot | null>}
 */
export async function getSnapshotById(id: string): Promise<AgentSnapshot | null> {
  const r = await (await db()).query('SELECT * FROM agent_snapshots WHERE id = $1', [id]);
  return r.rows.length ? rowToSnapshot(r.rows[0]) : null;
}

/**
 * Deletes a snapshot by UUID.
 *
 * @param {string} id - Snapshot UUID.
 * @returns {Promise<void>}
 */
export async function deleteSnapshot(id: string): Promise<void> {
  await (await db()).query('DELETE FROM agent_snapshots WHERE id = $1', [id]);
}

// =============================================================================
// Env Vars
// Platform-level secret store. Values are encrypted at rest using pgcrypto
// symmetric encryption with ENV_SECRET_KEY from the environment.
// Values are write-only — never returned by the web API.
// The runner decrypts values at agent start time using the same key.
// =============================================================================

/** The symmetric encryption key for env var values. Must be set in .env. */
function getEnvSecretKey(): string {
  const key = process.env.ENV_SECRET_KEY;
  if (!key) throw new Error('ENV_SECRET_KEY is not set — required for env var encryption');
  return key;
}

/**
 * Returns decrypted env var values keyed by name. For internal use only — never expose via API.
 */
export async function getEnvVarValues(): Promise<Record<string, string>> {
  const encKey = getEnvSecretKey();
  const r = await (await db()).query('SELECT key, value FROM env_vars');
  return Object.fromEntries(
    r.rows.map((row) => [row.key as string, decrypt(row.value as string, encKey)])
  );
}

/**
 * Returns all env var keys + metadata. Values are never included.
 *
 * @returns {Promise<Array<{ key: string; description?: string; updatedAt: Date }>>}
 */
export async function getAllEnvVars(): Promise<Array<{ key: string; description?: string; updatedAt: Date }>> {
  const r = await (await db()).query('SELECT key, description, updated_at FROM env_vars ORDER BY key');
  return r.rows.map(row => ({
    key: row.key as string,
    description: (row.description as string | null) ?? undefined,
    updatedAt: row.updated_at as Date,
  }));
}

/**
 * Upserts an env var. Value is encrypted using pgcrypto before storage.
 *
 * @param {string} key - Env var key (e.g. "REDSHIFT_DATABASE_URL").
 * @param {string} value - Secret value (encrypted before storage).
 * @param {string} [description] - Optional human-readable description.
 * @returns {Promise<void>}
 */
export async function setEnvVar(key: string, value: string, description?: string): Promise<void> {
  const encKey = getEnvSecretKey();
  const encrypted = encrypt(value, encKey);
  await (await db()).query(
    `INSERT INTO env_vars (key, value, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET
       value = $2,
       description = COALESCE($3, env_vars.description),
       updated_at = now()`,
    [key, encrypted, description ?? null],
  );
}

/**
 * Updates only the description of an existing env var (value unchanged).
 *
 * @param {string} key - Env var key.
 * @param {string} description - New description.
 * @returns {Promise<void>}
 */
export async function updateEnvVarDescription(key: string, description: string): Promise<void> {
  await (await db()).query(
    'UPDATE env_vars SET description = $2, updated_at = now() WHERE key = $1',
    [key, description],
  );
}

/**
 * Deletes an env var by key.
 *
 * @param {string} key - Env var key to delete.
 * @returns {Promise<void>}
 */
export async function deleteEnvVar(key: string): Promise<void> {
  await (await db()).query('DELETE FROM env_vars WHERE key = $1', [key]);
}
