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
  AgentGroup,
  WikiFolder,
  WikiSource,
  CreateWikiFolderRequest,
  UpdateWikiFolderRequest,
  CreateWikiSourceRequest,
} from '@slackhive/shared';
import { getDb, initDb, encrypt, decrypt, DEFAULT_AGENT_MODEL } from '@slackhive/shared';
import { getEncryptionKey } from './secrets';
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
    tags: (row.tags as string[]) ?? [],
    claudeMd: (row.claude_md as string) ?? '',
    createdBy: (row.created_by as string) ?? 'system',
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lastError: (row.last_error as string | null | undefined) ?? null,
    runnerId: (row.runner_id as string | null | undefined) ?? null,
    lastHeartbeat: (row.last_heartbeat as string | null | undefined) ?? null,
  };
}

/**
 * Compute `liveStatus` from persisted status + heartbeat age. The DB says
 * "running" but if the owning runner hasn't bumped its heartbeat in >45s
 * (3× the runner's 15s heartbeat), the process is likely dead. Surface that
 * as `stale` so the UI doesn't paint a green dot over a ghost.
 */
const STALE_HEARTBEAT_MS = 45_000;

/**
 * SQLite's `datetime('now')` returns naive UTC like `"2026-04-20 00:51:59"`.
 * `new Date(str)` parses that as LOCAL time, so in UTC+N every fresh
 * heartbeat looks N hours old. Normalize to ISO-with-Z before parsing.
 */
function parseDbTimestampMs(value: string): number {
  if (!value) return NaN;
  const hasTz = /[Zz]|[+\-]\d{2}:?\d{2}$/.test(value);
  const iso = hasTz ? value : value.replace(' ', 'T') + 'Z';
  return new Date(iso).getTime();
}

export function applyLiveStatus(agent: Agent): Agent {
  if (agent.status === 'running' && agent.lastHeartbeat) {
    const age = Date.now() - parseDbTimestampMs(agent.lastHeartbeat);
    agent.liveStatus = age > STALE_HEARTBEAT_MS ? 'stale' : 'running';
  } else {
    agent.liveStatus = agent.status;
  }
  return agent;
}

/** Enrich agent with platform credentials from platform_integrations table. */
async function enrichAgentWithPlatform(agent: Agent | null): Promise<Agent | null> {
  if (!agent) return null;
  const d = await db();
  const r = await d.query(
    'SELECT credentials, bot_user_id, bot_handle, bot_image_url FROM platform_integrations WHERE agent_id = $1 AND platform = $2 AND enabled = 1',
    [agent.id, 'slack']
  );
  if (r.rows.length > 0) {
    const raw = r.rows[0].credentials as string;
    const key = getEncryptionKey();
    let creds: Record<string, string> | null = null;
    try {
      creds = JSON.parse(decrypt(raw, key));
    } catch (err) {
      console.error(`[db] failed to decrypt platform credentials for agent ${agent.id}:`, (err as Error).message);
    }
    if (creds) {
      agent.slackBotToken = creds.botToken;
      agent.slackAppToken = creds.appToken;
      agent.slackSigningSecret = creds.signingSecret;
      agent.slackBotUserId = r.rows[0].bot_user_id as string | undefined;
      agent.slackBotHandle = r.rows[0].bot_handle as string | undefined;
      agent.slackBotImageUrl = r.rows[0].bot_image_url as string | undefined;
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
    createdBy: (row.created_by as string | undefined) ?? 'admin',
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
    description: (row.description as string | null) ?? null,
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
  const pi = await d.query('SELECT agent_id, credentials, bot_user_id, bot_handle, bot_image_url FROM platform_integrations WHERE platform = $1 AND enabled = 1', ['slack']);
  const credsByAgent = new Map<string, { credentials: string; botUserId?: string; botHandle?: string; botImageUrl?: string }>();
  for (const row of pi.rows) {
    credsByAgent.set(row.agent_id as string, {
      credentials: row.credentials as string,
      botUserId: row.bot_user_id as string | undefined,
      botHandle: row.bot_handle as string | undefined,
      botImageUrl: row.bot_image_url as string | undefined,
    });
  }

  const key = getEncryptionKey();
  for (const agent of agents) {
    const entry = credsByAgent.get(agent.id);
    if (entry) {
      let creds: Record<string, string> | null = null;
      try {
        creds = JSON.parse(decrypt(entry.credentials, key));
      } catch (err) {
        console.error(`[db] failed to decrypt platform credentials for agent ${agent.id}:`, (err as Error).message);
      }
      if (creds) {
        agent.slackBotToken = creds.botToken;
        agent.slackAppToken = creds.appToken;
        agent.slackSigningSecret = creds.signingSecret;
        agent.slackBotUserId = entry.botUserId;
        agent.slackBotHandle = entry.botHandle;
        agent.slackBotImageUrl = entry.botImageUrl;
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
       (id, slug, name, persona, description, model, is_boss, reports_to, tags, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      id, req.slug, req.name, req.persona ?? null, req.description ?? null,
      req.model ?? DEFAULT_AGENT_MODEL, req.isBoss ?? false, req.reportsTo ?? [],
      req.tags ?? [], createdBy,
    ]
  );

  // Create platform integration if credentials provided
  if (req.platformCredentials && req.platform) {
    const { encrypt } = await import('@slackhive/shared');
    await d.query(
      `INSERT INTO platform_integrations (id, agent_id, platform, credentials)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), id, req.platform, encrypt(JSON.stringify(req.platformCredentials), getEncryptionKey())]
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
/**
 * Calls Slack auth.test to get the bot user ID + handle, then users.info to
 * get the bot's profile image URL. Returns nulls on any failure — caller
 * decides whether to overwrite existing values.
 */
export async function fetchSlackBotProfile(botToken: string): Promise<{
  handle: string | null;
  userId: string | null;
  imageUrl: string | null;
}> {
  try {
    const authRes = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const auth = await authRes.json() as { ok: boolean; user?: string; user_id?: string };
    if (!auth.ok) return { handle: null, userId: null, imageUrl: null };

    const handle = auth.user ?? null;
    const userId = auth.user_id ?? null;
    let imageUrl: string | null = null;

    if (userId) {
      try {
        const infoRes = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        const info = await infoRes.json() as {
          ok: boolean;
          user?: { profile?: { image_192?: string; image_72?: string; image_512?: string } };
        };
        if (info.ok) {
          imageUrl = info.user?.profile?.image_192
            ?? info.user?.profile?.image_72
            ?? info.user?.profile?.image_512
            ?? null;
        }
      } catch { /* image is best-effort */ }
    }

    return { handle, userId, imageUrl };
  } catch {
    return { handle: null, userId: null, imageUrl: null };
  }
}

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
  if (req.tags !== undefined) { fields.push(`tags = $${idx++}`); values.push(req.tags); }
  if (req.verbose !== undefined) { fields.push(`verbose = $${idx++}`); values.push(req.verbose); }

  // Upsert platform credentials if provided
  if (req.platformCredentials) {
    const { encrypt } = await import('@slackhive/shared');
    const d = await db();
    const encrypted = encrypt(JSON.stringify(req.platformCredentials), getEncryptionKey());

    // Fetch bot handle + profile image from Slack if bot token provided
    let botHandle: string | null = null;
    let botImageUrl: string | null = null;
    if (req.platformCredentials.botToken) {
      const profile = await fetchSlackBotProfile(req.platformCredentials.botToken);
      botHandle = profile.handle ?? null;
      botImageUrl = profile.imageUrl ?? null;
    }

    // Check if integration row exists
    const existing = await d.query(
      `SELECT id FROM platform_integrations WHERE agent_id = $1 AND platform = 'slack'`,
      [id]
    );

    if (existing.rows.length > 0) {
      await d.query(
        `UPDATE platform_integrations SET credentials = $1,
           bot_handle = COALESCE($3, bot_handle),
           bot_image_url = COALESCE($4, bot_image_url)
         WHERE agent_id = $2 AND platform = 'slack'`,
        [encrypted, id, botHandle, botImageUrl]
      );
    } else {
      await d.query(
        `INSERT INTO platform_integrations (id, agent_id, platform, credentials, bot_handle, bot_image_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), id, 'slack', encrypted, botHandle, botImageUrl]
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
export async function createMcpServer(req: UpsertMcpServerRequest, createdBy = 'admin'): Promise<McpServer> {
  const id = randomUUID();
  const r = await (await db()).query(
    `INSERT INTO mcp_servers (id, name, type, config, description, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [id, req.name, req.type, JSON.stringify(req.config), req.description ?? null, req.enabled ?? true, createdBy]
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
  sortOrder = 0,
  description?: string | null,
): Promise<Skill> {
  const id = randomUUID();
  // Description handling: on INSERT use the provided value (or NULL).
  // On CONFLICT, preserve the existing description unless the caller
  // explicitly provides one — content edits shouldn't wipe a description
  // the runner summarizer (or user) put there. Snapshot restore passes the
  // snapshotted description so it round-trips correctly.
  const r = await (await db()).query(
    `INSERT INTO skills (id, agent_id, category, filename, content, sort_order, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (agent_id, category, filename)
     DO UPDATE SET
       content     = EXCLUDED.content,
       sort_order  = EXCLUDED.sort_order,
       description = COALESCE($7, skills.description),
       updated_at  = now()
     RETURNING *`,
    [id, agentId, category, filename, content, sortOrder, description ?? null]
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
 * Updates only the description of a skill. Used by the runner-side Haiku
 * summarizer (background fill) and the UI Regenerate button. Does not bump
 * `updated_at` because a description refresh is metadata, not a content edit —
 * keeping `updated_at` stable means snapshot/diff tooling won't flag it.
 *
 * @param {string} skillId - Skill UUID.
 * @param {string | null} description - New description (or null to clear).
 * @returns {Promise<Skill | null>} Updated skill or null if not found.
 */
export async function updateSkillDescription(skillId: string, description: string | null): Promise<Skill | null> {
  const r = await (await db()).query(
    'UPDATE skills SET description = $1 WHERE id = $2 RETURNING *',
    [description, skillId]
  );
  return r.rows[0] ? rowToSkill(r.rows[0]) : null;
}

/**
 * Loads a single skill by ID. Used by the runner subscriber after a
 * `skill-saved` event, since the event payload only carries IDs.
 */
export async function getSkillById(skillId: string): Promise<Skill | null> {
  const r = await (await db()).query('SELECT * FROM skills WHERE id = $1', [skillId]);
  return r.rows[0] ? rowToSkill(r.rows[0]) : null;
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
export async function getAllUsers(): Promise<Array<{ id: string; username: string; role: string; createdAt: string; fromSlack: boolean; agentCount: number }>> {
  const r = await (await db()).query(`
    SELECT u.id, u.username, u.role, u.created_at, u.slack_user_id,
           COUNT(aa.agent_id) AS agent_count
    FROM users u
    LEFT JOIN agent_access aa ON aa.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at
  `);
  return r.rows.map(row => ({
    id: row.id as string,
    username: row.username as string,
    role: row.role as string,
    createdAt: row.created_at as string,
    fromSlack: !!(row.slack_user_id),
    agentCount: Number(row.agent_count ?? 0),
  }));
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
 * Returns the `slack_user_id` for a given DB user id, or `null` when the user
 * has no Slack mapping (admin-created local user). Used by mutation routes
 * that want to publish a targeted `user-access-changed` event so the runner
 * can flush a single cache entry instead of clearing the whole cache.
 */
export async function getUserSlackIdById(id: string): Promise<string | null> {
  const r = await (await db()).query(
    'SELECT slack_user_id FROM users WHERE id = $1',
    [id]
  );
  if (!r.rows.length) return null;
  return (r.rows[0].slack_user_id as string | null) ?? null;
}

/**
 * Looks up a user by their Slack user ID (sub claim from OpenID Connect).
 */
export async function getUserBySlackId(slackUserId: string): Promise<{ id: string; username: string; role: string } | null> {
  const r = await (await db()).query(
    'SELECT id, username, role FROM users WHERE slack_user_id = $1',
    [slackUserId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { id: row.id as string, username: row.username as string, role: row.role as string };
}

/**
 * Creates or returns an existing user authenticated via Slack OAuth.
 * New users are created with role=viewer.
 */

export async function saveBotHandle(agentId: string, handle: string): Promise<void> {
  const d = await db();
  await d.query(
    `UPDATE platform_integrations SET bot_handle = $1 WHERE agent_id = $2 AND platform = 'slack'`,
    [handle, agentId]
  );
}

export async function upsertSlackUser(
  slackUserId: string,
  email: string | null,
  name: string,
): Promise<{ id: string; username: string; role: string }> {
  const existing = await getUserBySlackId(slackUserId);
  if (existing) return existing;

  const id = randomUUID();
  // username falls back to email-or-slackId so we never store an empty string;
  // slack_email stays NULL when Slack didn't return one (no users:read.email
  // scope, app/bot user, or guest with hidden email). NULL is the correct
  // "unknown email" signal — earlier callers passed the display name as email,
  // which broke domain filtering and email-based dedup.
  const username = name || email || slackUserId;
  const r = await (await db()).query(
    'INSERT INTO users (id, username, password_hash, role, slack_user_id, slack_email) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, role',
    [id, username, null, 'viewer', slackUserId, email],
  );
  const row = r.rows[0];
  return { id: row.id as string, username: row.username as string, role: row.role as string };
}

export async function fixSlackUsername(id: string, name: string): Promise<{ id: string; username: string; role: string } | null> {
  const r = await (await db()).query(
    'UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username, role',
    [name, id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { id: row.id as string, username: row.username as string, role: row.role as string };
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

/**
 * Updates a user's password hash.
 *
 * @param {string} id - User UUID.
 * @param {string} passwordHash - Bcrypt hash of the new password.
 * @returns {Promise<void>}
 */
export async function updateUserPassword(id: string, passwordHash: string): Promise<void> {
  await (await db()).query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
}

// =============================================================================
// Agent access control
// =============================================================================

/**
 * Returns all users with access to an agent — both explicit grants and the creator.
 * isOwner=true means access comes from created_by (not a grant row).
 */
export async function getAgentWriteUsers(agentId: string): Promise<{ userId: string; username: string; canWrite: boolean; accessLevel: string; isOwner: boolean }[]> {
  const r = await (await db()).query(
    `SELECT aa.user_id, u.username, aa.can_write, aa.access_level,
            CASE WHEN a.created_by = u.username THEN 1 ELSE 0 END as is_owner
     FROM agent_access aa
     JOIN users u ON u.id = aa.user_id
     JOIN agents a ON a.id = aa.agent_id
     WHERE aa.agent_id = $1
     UNION
     SELECT u.id as user_id, u.username, 1 as can_write, 'edit' as access_level, 1 as is_owner
     FROM agents a
     JOIN users u ON u.username = a.created_by
     WHERE a.id = $1
       AND NOT EXISTS (SELECT 1 FROM agent_access aa2 WHERE aa2.agent_id = $1 AND aa2.user_id = u.id)
     ORDER BY username`,
    [agentId]
  );
  return r.rows.map(row => ({
    userId: row.user_id as string,
    username: row.username as string,
    canWrite: row.can_write === 1 || row.can_write === true,
    accessLevel: (row.access_level as string) ?? (row.can_write ? 'edit' : 'view'),
    isOwner: row.is_owner === 1 || row.is_owner === true,
  }));
}

/**
 * Grants access to a user for an agent. canWrite=true = edit, canWrite=false = view only.
 * Upserts so calling again with a different canWrite updates the existing grant.
 */
export type AgentAccessLevel = 'trigger' | 'view' | 'edit';

export async function grantAgentAccess(agentId: string, userId: string, accessLevel: AgentAccessLevel): Promise<void> {
  const canWrite = accessLevel === 'edit' ? 1 : 0;
  await (await db()).query(
    `INSERT INTO agent_access (agent_id, user_id, can_write, access_level) VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, user_id) DO UPDATE SET can_write = $3, access_level = $4`,
    [agentId, userId, canWrite, accessLevel]
  );
}

/** @deprecated use grantAgentAccess */
export async function grantAgentWrite(agentId: string, userId: string): Promise<void> {
  return grantAgentAccess(agentId, userId, 'edit');
}

/**
 * Revokes all access from a user for an agent.
 */
export async function revokeAgentWrite(agentId: string, userId: string): Promise<void> {
  await (await db()).query('DELETE FROM agent_access WHERE agent_id = $1 AND user_id = $2', [agentId, userId]);
}

/**
 * Returns true if a user can see an agent in SlackHive (view or edit level).
 * Trigger-only users are excluded — they can use the bot in Slack but not see SlackHive.
 */
export async function userCanReadAgent(agentId: string, username: string, role: string): Promise<boolean> {
  if (role === 'admin' || role === 'superadmin') return true;
  const r = await (await db()).query(
    `SELECT 1 FROM agents WHERE id = $1 AND created_by = $2
     UNION
     SELECT 1 FROM agent_access aa JOIN users u ON u.id = aa.user_id
       WHERE aa.agent_id = $1 AND u.username = $2 AND aa.access_level IN ('view', 'edit')
     LIMIT 1`,
    [agentId, username]
  );
  return r.rows.length > 0;
}

/**
 * Returns true if a user has write (edit) access to an agent.
 */
export async function userCanWriteAgent(agentId: string, username: string, role: string): Promise<boolean> {
  if (role === 'admin' || role === 'superadmin') return true;
  const r = await (await db()).query(
    `SELECT 1 FROM agents WHERE id = $1 AND created_by = $2
     UNION
     SELECT 1 FROM agent_access aa JOIN users u ON u.id = aa.user_id
       WHERE aa.agent_id = $1 AND u.username = $2 AND aa.access_level = 'edit'
     LIMIT 1`,
    [agentId, username]
  );
  return r.rows.length > 0;
}

/**
 * Returns true if a user can delete an agent. Stricter than write — only the
 * creator or an admin/superadmin qualifies. Editor-grant collaborators can
 * modify the agent but cannot remove it (delete is irreversible).
 */
export async function userCanDeleteAgent(agentId: string, username: string, role: string): Promise<boolean> {
  if (role === 'admin' || role === 'superadmin') return true;
  const r = await (await db()).query(
    `SELECT 1 FROM agents WHERE id = $1 AND created_by = $2 LIMIT 1`,
    [agentId, username]
  );
  return r.rows.length > 0;
}


/**
 * Returns agent IDs where the user has edit access (for job creation).
 * Includes agents created by the user and those with an explicit edit grant.
 * Admins return null (no restriction).
 */
export async function listWritableAgentIds(
  username: string,
  role: string,
): Promise<string[] | null> {
  if (role === 'admin' || role === 'superadmin') return null;
  const r = await (await db()).query(
    `SELECT id FROM agents WHERE created_by = $1
     UNION
     SELECT aa.agent_id FROM agent_access aa
       JOIN users u ON u.id = aa.user_id
      WHERE u.username = $1 AND aa.access_level = 'edit'`,
    [username],
  );
  return r.rows.map(row => row.id as string);
}

export async function listAccessibleAgentIds(
  username: string,
  role: string,
): Promise<string[] | null> {
  if (role === 'admin' || role === 'superadmin') return null;
  const r = await (await db()).query(
    `SELECT id FROM agents WHERE created_by = $1
     UNION
     SELECT aa.agent_id FROM agent_access aa
       JOIN users u ON u.id = aa.user_id
      WHERE u.username = $1 AND aa.access_level IN ('view', 'edit')`,
    [username],
  );
  return r.rows.map(row => row.id as string);
}

// =============================================================================
// Agent groups (audience personalization)
// =============================================================================

/**
 * Maps a SQLite UNIQUE-constraint error to a typed conflict descriptor that
 * route handlers can return as a 409 with a `field`. Driver-agnostic in the
 * sense that we match on table.column substrings — Postgres would need its
 * own parser, which is fine because we only run on SQLite today.
 *
 * Returns null if the error is not a recognised conflict.
 */
export function parseAgentGroupsConflict(err: unknown): { field: 'priority' | 'name'; message: string } | null {
  const msg = (err as Error)?.message ?? '';
  if (/UNIQUE constraint failed:\s*agent_groups\.agent_id,\s*agent_groups\.priority/i.test(msg)) {
    return { field: 'priority', message: 'Another audience already uses that priority. Pick a different number.' };
  }
  if (/UNIQUE constraint failed:\s*agent_groups\.agent_id,\s*agent_groups\.name/i.test(msg)) {
    return { field: 'name', message: 'Another audience on this agent already has that name.' };
  }
  return null;
}


function rowToAgentGroup(row: Record<string, unknown>): AgentGroup {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    instructions: (row.instructions as string) ?? '',
    priority: Number(row.priority ?? 100),
    verbose: row.verbose === 1 || row.verbose === true,
    memberCount: row.member_count == null ? undefined : Number(row.member_count),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/** All groups for an agent, ordered by priority then name. Includes member counts. */
export async function listAgentGroups(agentId: string): Promise<AgentGroup[]> {
  const r = await (await db()).query(
    `SELECT g.*, (SELECT COUNT(*) FROM agent_group_members m WHERE m.group_id = g.id) AS member_count
       FROM agent_groups g
      WHERE g.agent_id = $1
      ORDER BY g.priority ASC, g.name ASC`,
    [agentId]
  );
  return r.rows.map(rowToAgentGroup);
}

export async function getAgentGroup(groupId: string): Promise<AgentGroup | null> {
  const r = await (await db()).query(
    `SELECT g.*, (SELECT COUNT(*) FROM agent_group_members m WHERE m.group_id = g.id) AS member_count
       FROM agent_groups g
      WHERE g.id = $1`,
    [groupId]
  );
  return r.rows.length ? rowToAgentGroup(r.rows[0] as Record<string, unknown>) : null;
}

export async function createAgentGroup(input: {
  agentId: string;
  name: string;
  description?: string | null;
  instructions?: string;
  priority?: number;
  verbose?: boolean;
}): Promise<AgentGroup> {
  const id = randomUUID();
  await (await db()).query(
    `INSERT INTO agent_groups (id, agent_id, name, description, instructions, priority, verbose)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.agentId,
      input.name,
      input.description ?? null,
      input.instructions ?? '',
      input.priority ?? 100,
      input.verbose ? 1 : 0,
    ]
  );
  const created = await getAgentGroup(id);
  if (!created) throw new Error(`Group ${id} disappeared after insert`);
  return created;
}

export async function updateAgentGroup(
  groupId: string,
  patch: { name?: string; description?: string | null; instructions?: string; priority?: number; verbose?: boolean }
): Promise<AgentGroup | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let n = 1;
  if (patch.name !== undefined)         { sets.push(`name = $${n++}`);         params.push(patch.name); }
  if (patch.description !== undefined)  { sets.push(`description = $${n++}`);  params.push(patch.description); }
  if (patch.instructions !== undefined) { sets.push(`instructions = $${n++}`); params.push(patch.instructions); }
  if (patch.priority !== undefined)     { sets.push(`priority = $${n++}`);     params.push(patch.priority); }
  if (patch.verbose !== undefined)      { sets.push(`verbose = $${n++}`);      params.push(patch.verbose ? 1 : 0); }
  if (sets.length === 0) return getAgentGroup(groupId);
  sets.push(`updated_at = datetime('now')`);
  params.push(groupId);
  await (await db()).query(
    `UPDATE agent_groups SET ${sets.join(', ')} WHERE id = $${n}`,
    params
  );
  return getAgentGroup(groupId);
}

export async function deleteAgentGroup(groupId: string): Promise<void> {
  await (await db()).query(`DELETE FROM agent_groups WHERE id = $1`, [groupId]);
}

/**
 * Users who can at least *trigger* this agent (i.e. could receive a response
 * from it via Slack). Used to filter the audience-membership picker so admins
 * don't accidentally add a user who has no path to interact with the agent.
 *
 * Eligibility = admins/superadmins ∪ agent creator ∪ anyone with an
 * `agent_access` row of any level. Mirrors the trigger logic in
 * `apps/runner/src/message-handler.ts:userCanTrigger`.
 */
export type EligibleUserAccessLevel = 'admin' | 'owner' | 'edit' | 'view' | 'trigger';

export interface EligibleUser {
  id: string;
  username: string;
  role: string;
  /** Why this user is eligible: 'admin' (role), 'creator' (agent owner), or 'access' (agent_access grant). */
  source: 'admin' | 'creator' | 'access';
  /**
   * Effective access level on this specific agent, in user-friendly form:
   * 'admin' (role-based), 'owner' (creator), or one of 'edit'/'view'/'trigger'
   * (from agent_access.access_level). Used by the audience picker so it's
   * obvious whether a member is a viewer with trigger-only Slack access vs
   * an editor with full SlackHive write.
   */
  accessLevel: EligibleUserAccessLevel;
}

export async function listAgentEligibleUsers(agentId: string): Promise<EligibleUser[]> {
  // NOTE: the SQLite adapter detects reads vs writes by checking whether the
  // statement starts with "SELECT" — so we cannot use a leading CTE (`WITH …`)
  // here. Use SELECT … FROM (UNION ALL) instead, with a numeric source rank
  // (lower = stronger) that we MIN() to pick the best label per user.
  //
  // The third UNION arm carries the actual `agent_access.access_level` so
  // the audience picker can distinguish trigger-only users from view/edit
  // users (they all appear in the list, but their effective level differs).
  const r = await (await db()).query(
    `SELECT id, username, role,
            MIN(source_rank) AS top_rank,
            MAX(access_level) AS access_level
       FROM (
         SELECT u.id, u.username, u.role, 1 AS source_rank, NULL AS access_level
           FROM users u
          WHERE u.role IN ('admin', 'superadmin')
         UNION ALL
         SELECT u.id, u.username, u.role, 2 AS source_rank, NULL AS access_level
           FROM users u
           JOIN agents a ON a.created_by = u.username
          WHERE a.id = $1
         UNION ALL
         SELECT u.id, u.username, u.role, 3 AS source_rank, aa.access_level
           FROM users u
           JOIN agent_access aa ON aa.user_id = u.id
          WHERE aa.agent_id = $2
       ) sub
      GROUP BY id, username, role
      ORDER BY username ASC`,
    [agentId, agentId]
  );
  return r.rows.map(row => {
    const rank = Number(row.top_rank);
    const source: 'admin' | 'creator' | 'access' = rank === 1 ? 'admin' : rank === 2 ? 'creator' : 'access';
    // For source=access, prefer the grant's `access_level`. MAX over the
    // text values orders them lexicographically: 'view' > 'trigger' > 'edit'
    // — not the access hierarchy we want. So if the user has multiple
    // distinct grants on this agent (shouldn't happen, PK enforces unique),
    // we pick whatever MAX returns; for the common single-row case it's
    // exactly the grant's level.
    let accessLevel: EligibleUserAccessLevel;
    if (source === 'admin') accessLevel = 'admin';
    else if (source === 'creator') accessLevel = 'owner';
    else {
      const raw = (row.access_level as string | null) ?? 'trigger';
      accessLevel = (raw === 'edit' || raw === 'view' || raw === 'trigger') ? raw : 'trigger';
    }
    return {
      id: row.id as string,
      username: row.username as string,
      role: row.role as string,
      source,
      accessLevel,
    };
  });
}

/** Members of a group as user rows (id + username). */
export async function listGroupMembers(groupId: string): Promise<{ userId: string; username: string }[]> {
  const r = await (await db()).query(
    `SELECT u.id, u.username
       FROM agent_group_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.group_id = $1
      ORDER BY u.username ASC`,
    [groupId]
  );
  return r.rows.map(row => ({ userId: row.id as string, username: row.username as string }));
}

/**
 * Replaces the membership of a group with the given user IDs atomically.
 *
 * DELETE + single multi-row INSERT, wrapped in a transaction so a partial
 * failure can't leave the group with the old rows deleted but the new rows
 * not yet inserted. De-dupes input in JS so the multi-row INSERT can drop
 * the per-row ON CONFLICT clause.
 */
export async function setGroupMembers(groupId: string, userIds: string[]): Promise<void> {
  const conn = await db();
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  await conn.transaction(async tx => {
    await tx.query(`DELETE FROM agent_group_members WHERE group_id = $1`, [groupId]);
    if (unique.length === 0) return;
    // Build ($1, $2), ($1, $3), ... — group_id stays at $1, users at $2..$N.
    const placeholders = unique.map((_, i) => `($1, $${i + 2})`).join(', ');
    await tx.query(
      `INSERT INTO agent_group_members (group_id, user_id) VALUES ${placeholders}`,
      [groupId, ...unique]
    );
  });
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
    createdBy: (row.created_by as string) ?? 'system',
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
export async function getAllJobs(agentIds?: string[] | null): Promise<Array<ScheduledJob & { lastRun?: JobRun }>> {
  const adapter = await db();
  // null = all jobs (admin), undefined = all jobs, array = filter to those agent IDs
  const params: unknown[] = [];
  let whereClause = '';
  if (Array.isArray(agentIds)) {
    if (agentIds.length === 0) return [];
    params.push(...agentIds);
    const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(', ');
    whereClause = `WHERE j.agent_id IN (${placeholders})`;
  }

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
      ${whereClause}
      ORDER BY j.created_at DESC
    `, params);
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
    ${whereClause}
    ORDER BY j.created_at DESC
  `, params);
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
    `INSERT INTO scheduled_jobs (id, agent_id, name, prompt, cron_schedule, target_type, target_id, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [id, req.agentId, req.name, req.prompt, req.cronSchedule, req.targetType ?? 'channel', req.targetId, req.enabled ?? true, req.createdBy ?? 'system']
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

/**
 * Returns decrypted env var values keyed by name. For internal use only — never expose via API.
 */
export async function getEnvVarValues(): Promise<Record<string, string>> {
  const encKey = getEncryptionKey();
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
export async function getAllEnvVars(): Promise<Array<{ key: string; description?: string; createdBy: string; updatedAt: Date }>> {
  const r = await (await db()).query('SELECT key, description, created_by, updated_at FROM env_vars ORDER BY key');
  return r.rows.map(row => ({
    key: row.key as string,
    description: (row.description as string | null) ?? undefined,
    createdBy: (row.created_by as string | undefined) ?? 'admin',
    updatedAt: row.updated_at as Date,
  }));
}

export async function getEnvVarCreatedBy(key: string): Promise<string | null> {
  const r = await (await db()).query('SELECT created_by FROM env_vars WHERE key = $1', [key]);
  if (!r.rows.length) return null;
  return (r.rows[0].created_by as string | undefined) ?? 'admin';
}

/**
 * Upserts an env var. Value is AES-encrypted with ENV_SECRET_KEY (app-layer,
 * via @slackhive/shared `encrypt`) before storage. Works identically for
 * SQLite and Postgres — the column stores ciphertext either way.
 *
 * @param {string} key - Env var key (e.g. "REDSHIFT_DATABASE_URL").
 * @param {string} value - Plaintext secret; encrypted before storage.
 * @param {string} [description] - Optional human-readable description.
 * @returns {Promise<void>}
 */
export async function setEnvVar(key: string, value: string, description?: string, createdBy = 'admin'): Promise<void> {
  const encKey = getEncryptionKey();
  const encrypted = encrypt(value, encKey);
  await (await db()).query(
    `INSERT INTO env_vars (key, value, description, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       value = $2,
       description = COALESCE($3, env_vars.description),
       updated_at = now()`,
    [key, encrypted, description ?? null, createdBy],
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

// =============================================================================
// Wiki Folders
// =============================================================================

function rowToWikiFolder(row: Record<string, unknown>): WikiFolder {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    createdBy: (row.created_by ?? row.createdBy) as string,
    createdAt: new Date((row.created_at ?? row.createdAt) as string),
    updatedAt: new Date((row.updated_at ?? row.updatedAt) as string),
  };
}

function rowToWikiSource(row: Record<string, unknown>): WikiSource {
  return {
    id: row.id as string,
    folderId: (row.folder_id ?? row.folderId) as string,
    type: row.type as WikiSource['type'],
    name: row.name as string,
    url: row.url as string | undefined,
    repoUrl: (row.repo_url ?? row.repoUrl) as string | undefined,
    branch: row.branch as string | undefined,
    patEnvRef: (row.pat_env_ref ?? row.patEnvRef) as string | undefined,
    content: row.content as string | undefined,
    status: row.status as WikiSource['status'],
    wordCount: (row.word_count ?? row.wordCount ?? 0) as number,
    lastSynced: (row.last_synced ?? row.lastSynced) as string | undefined,
    createdAt: new Date((row.created_at ?? row.createdAt) as string),
  };
}

export async function getAllWikiFolders(): Promise<WikiFolder[]> {
  const r = await (await db()).query('SELECT * FROM wiki_folders ORDER BY name ASC', []);
  return r.rows.map(rowToWikiFolder);
}

export async function getWikiFolder(id: string): Promise<WikiFolder | null> {
  const r = await (await db()).query('SELECT * FROM wiki_folders WHERE id = $1', [id]);
  return r.rows[0] ? rowToWikiFolder(r.rows[0]) : null;
}

export async function createWikiFolder(req: CreateWikiFolderRequest, createdBy = 'admin'): Promise<WikiFolder> {
  const id = randomUUID();
  await (await db()).query(
    'INSERT INTO wiki_folders (id, name, description, created_by) VALUES ($1, $2, $3, $4)',
    [id, req.name, req.description ?? null, createdBy],
  );
  return (await getWikiFolder(id))!;
}

export async function updateWikiFolder(id: string, req: UpdateWikiFolderRequest): Promise<WikiFolder | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (req.name !== undefined) { sets.push(`name = $${i++}`); vals.push(req.name); }
  if (req.description !== undefined) { sets.push(`description = $${i++}`); vals.push(req.description); }
  if (!sets.length) return getWikiFolder(id);
  sets.push(`updated_at = datetime('now')`);
  vals.push(id);
  await (await db()).query(`UPDATE wiki_folders SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  return getWikiFolder(id);
}

export async function deleteWikiFolder(id: string): Promise<void> {
  await (await db()).query('DELETE FROM wiki_folders WHERE id = $1', [id]);
}

export async function getWikiSourceFolder(sourceId: string): Promise<string | null> {
  const r = await (await db()).query('SELECT folder_id FROM wiki_sources WHERE id = $1', [sourceId]);
  return r.rows[0] ? (r.rows[0].folder_id as string) : null;
}

export async function getWikiSources(folderId: string): Promise<WikiSource[]> {
  const r = await (await db()).query('SELECT * FROM wiki_sources WHERE folder_id = $1 ORDER BY name ASC', [folderId]);
  return r.rows.map(rowToWikiSource);
}

export async function getWikiSource(id: string): Promise<WikiSource | null> {
  const r = await (await db()).query('SELECT * FROM wiki_sources WHERE id = $1', [id]);
  return r.rows[0] ? rowToWikiSource(r.rows[0]) : null;
}

export async function createWikiSource(folderId: string, req: CreateWikiSourceRequest): Promise<WikiSource> {
  const id = randomUUID();
  await (await db()).query(
    `INSERT INTO wiki_sources (id, folder_id, type, name, content, url, repo_url, branch, pat_env_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, folderId, req.type, req.name, req.content ?? null, req.url ?? null, req.repoUrl ?? null, req.branch ?? 'main', req.patEnvRef ?? null],
  );
  const r = await (await db()).query('SELECT * FROM wiki_sources WHERE id = $1', [id]);
  return rowToWikiSource(r.rows[0]);
}

export async function updateWikiSource(id: string, patch: Partial<CreateWikiSourceRequest & { status: string; wordCount: number; lastSynced: string }>): Promise<WikiSource | null> {
  const map: Record<string, string> = { repoUrl: 'repo_url', patEnvRef: 'pat_env_ref', wordCount: 'word_count', lastSynced: 'last_synced' };
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    const col = map[k] ?? k;
    sets.push(`${col} = $${i++}`);
    vals.push(v);
  }
  if (!sets.length) {
    const r2 = await (await db()).query('SELECT * FROM wiki_sources WHERE id = $1', [id]);
    return r2.rows[0] ? rowToWikiSource(r2.rows[0]) : null;
  }
  vals.push(id);
  await (await db()).query(`UPDATE wiki_sources SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  const r = await (await db()).query('SELECT * FROM wiki_sources WHERE id = $1', [id]);
  return r.rows[0] ? rowToWikiSource(r.rows[0]) : null;
}

export async function deleteWikiSource(id: string): Promise<void> {
  await (await db()).query('DELETE FROM wiki_sources WHERE id = $1', [id]);
}

export async function getAgentWikiFolders(agentId: string): Promise<WikiFolder[]> {
  const r = await (await db()).query(
    `SELECT wf.* FROM wiki_folders wf
     JOIN agent_wiki_folders awf ON awf.folder_id = wf.id
     WHERE awf.agent_id = $1
     ORDER BY wf.name ASC`,
    [agentId],
  );
  return r.rows.map(rowToWikiFolder);
}

export async function assignWikiFolder(agentId: string, folderId: string): Promise<void> {
  await (await db()).query(
    'INSERT OR IGNORE INTO agent_wiki_folders (agent_id, folder_id) VALUES ($1, $2)',
    [agentId, folderId],
  );
}

export async function unassignWikiFolder(agentId: string, folderId: string): Promise<void> {
  await (await db()).query(
    'DELETE FROM agent_wiki_folders WHERE agent_id = $1 AND folder_id = $2',
    [agentId, folderId],
  );
}
