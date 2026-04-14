/**
 * @fileoverview Database client for the runner service.
 *
 * Uses the shared DbAdapter to support both PostgreSQL and SQLite.
 * Provides typed query helpers for all tables used by the runner:
 * agents, mcp_servers, agent_mcps, skills, permissions, memories, and sessions.
 *
 * @module runner/db
 */

import { randomUUID } from 'crypto';
import { getDb, encrypt, decrypt } from '@slackhive/shared';
import { logger } from './logger';
import type {
  Agent,
  McpServer,
  ScheduledJob,
  Skill,
  Permission,
  Restriction,
  Memory,
  Session,
  AgentStatus,
} from '@slackhive/shared';

// =============================================================================
// Row mappers — convert snake_case DB columns to camelCase TS interfaces
// =============================================================================

function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    persona: row.persona as string | undefined,
    description: row.description as string | undefined,
    // Slack credentials now in platform_integrations table
    model: row.model as string,
    status: row.status as AgentStatus,
    enabled: row.enabled !== false && row.enabled !== 0,
    isBoss: row.is_boss === true || row.is_boss === 1,
    verbose: row.verbose !== 0 && row.verbose !== false,
    reportsTo: (Array.isArray(row.reports_to) ? row.reports_to : []) as string[],
    claudeMd: (row.claude_md as string) ?? '',
    createdBy: (row.created_by as string) ?? 'system',
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
    enabled: row.enabled !== false && row.enabled !== 0,
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

function rowToPermission(row: Record<string, unknown>): Permission {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    allowedTools: (Array.isArray(row.allowed_tools) ? row.allowed_tools : []) as string[],
    deniedTools: (Array.isArray(row.denied_tools) ? row.denied_tools : []) as string[],
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

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionKey: row.session_key as string,
    claudeSessionId: row.claude_session_id as string | undefined,
    mcpHash: row.mcp_hash as string | undefined,
    lastActivity: row.last_activity as Date,
  };
}

function rowToRestriction(row: Record<string, unknown>): Restriction {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    allowedChannels: (Array.isArray(row.allowed_channels) ? row.allowed_channels : []) as string[],
    updatedAt: row.updated_at as Date,
  };
}

// =============================================================================
// Agent queries
// =============================================================================

export async function getAllAgents(): Promise<Agent[]> {
  const result = await getDb().query(
    'SELECT * FROM agents ORDER BY is_boss DESC, created_at ASC'
  );
  return result.rows.map(rowToAgent);
}

export async function getAgentById(id: string): Promise<Agent | null> {
  const result = await getDb().query('SELECT * FROM agents WHERE id = $1', [id]);
  return result.rows.length > 0 ? rowToAgent(result.rows[0]) : null;
}

export async function updateAgentStatus(id: string, status: AgentStatus): Promise<void> {
  await getDb().query(
    'UPDATE agents SET status = $1, updated_at = now() WHERE id = $2',
    [status, id]
  );
}

export async function updateAgentSlackUserId(id: string, slackBotUserId: string): Promise<void> {
  await getDb().query(
    'UPDATE platform_integrations SET bot_user_id = $1 WHERE agent_id = $2 AND platform = $3',
    [slackBotUserId, id, 'slack']
  );
}

/** Get platform integration for an agent. */
export async function getPlatformIntegration(agentId: string, platform: string): Promise<{ credentials: Record<string, string>; botUserId?: string } | null> {
  const r = await getDb().query(
    'SELECT credentials, bot_user_id FROM platform_integrations WHERE agent_id = $1 AND platform = $2 AND enabled = 1',
    [agentId, platform]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const raw = row.credentials as string;
  try {
    // Try encrypted first
    const { decrypt } = await import('@slackhive/shared');
    const key = process.env.ENV_SECRET_KEY ?? process.env.AUTH_SECRET ?? 'slackhive-default-key';
    const creds = JSON.parse(decrypt(raw, key));
    return { credentials: creds, botUserId: row.bot_user_id as string | undefined };
  } catch {
    // Fallback: plain JSON (migrated data or dev mode)
    try {
      return { credentials: JSON.parse(raw), botUserId: row.bot_user_id as string | undefined };
    } catch { return null; }
  }
}

// =============================================================================
// MCP server queries
// =============================================================================

export async function getAgentMcpServers(agentId: string): Promise<McpServer[]> {
  const result = await getDb().query(
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

export async function getAgentSkills(agentId: string): Promise<Skill[]> {
  const result = await getDb().query(
    `SELECT * FROM skills
     WHERE agent_id = $1
     ORDER BY category ASC, sort_order ASC, filename ASC`,
    [agentId]
  );
  return result.rows.map(rowToSkill);
}

export async function upsertSkill(
  agentId: string,
  category: string,
  filename: string,
  content: string,
  sortOrder = 0
): Promise<Skill> {
  const id = randomUUID();
  const result = await getDb().query(
    `INSERT INTO skills (id, agent_id, category, filename, content, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (agent_id, category, filename)
     DO UPDATE SET content = EXCLUDED.content, sort_order = EXCLUDED.sort_order, updated_at = now()
     RETURNING *`,
    [id, agentId, category, filename, content, sortOrder]
  );
  return rowToSkill(result.rows[0]);
}

export async function deleteSkill(
  agentId: string,
  category: string,
  filename: string,
): Promise<boolean> {
  const result = await getDb().query(
    'DELETE FROM skills WHERE agent_id = $1 AND category = $2 AND filename = $3',
    [agentId, category, filename]
  );
  return (result.rowCount ?? 0) > 0;
}

// =============================================================================
// Permissions queries
// =============================================================================

export async function getAgentPermissions(agentId: string): Promise<Permission | null> {
  const result = await getDb().query(
    'SELECT * FROM permissions WHERE agent_id = $1',
    [agentId]
  );
  return result.rows.length > 0 ? rowToPermission(result.rows[0]) : null;
}

// =============================================================================
// Restrictions queries
// =============================================================================

export async function getAgentRestrictions(agentId: string): Promise<Restriction | null> {
  const result = await getDb().query(
    'SELECT * FROM agent_restrictions WHERE agent_id = $1',
    [agentId]
  );
  return result.rows.length > 0 ? rowToRestriction(result.rows[0]) : null;
}

// =============================================================================
// Memory queries
// =============================================================================

export async function getAgentMemories(agentId: string): Promise<Memory[]> {
  const result = await getDb().query(
    `SELECT * FROM memories
     WHERE agent_id = $1
     ORDER BY type ASC, created_at ASC`,
    [agentId]
  );
  return result.rows.map(rowToMemory);
}

export async function upsertMemory(
  agentId: string,
  type: Memory['type'],
  name: string,
  content: string
): Promise<Memory> {
  const id = randomUUID();
  const result = await getDb().query(
    `INSERT INTO memories (id, agent_id, type, name, content)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id, name) DO UPDATE
       SET content = EXCLUDED.content,
           type = EXCLUDED.type,
           updated_at = now()
     RETURNING *`,
    [id, agentId, type, name, content]
  );
  return rowToMemory(result.rows[0]);
}

export async function upsertMemorySafe(
  agentId: string,
  type: Memory['type'],
  name: string,
  content: string
): Promise<void> {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO memories (id, agent_id, type, name, content)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id, name) DO UPDATE
       SET content = EXCLUDED.content,
           type = EXCLUDED.type,
           updated_at = now()`,
    [id, agentId, type, name, content]
  );
}

// =============================================================================
// Session queries
// =============================================================================

export async function getSession(agentId: string, sessionKey: string): Promise<Session | null> {
  const result = await getDb().query(
    'SELECT * FROM sessions WHERE agent_id = $1 AND session_key = $2',
    [agentId, sessionKey]
  );
  return result.rows.length > 0 ? rowToSession(result.rows[0]) : null;
}

export async function upsertSession(
  agentId: string,
  sessionKey: string,
  claudeSessionId?: string,
  mcpHash?: string
): Promise<Session> {
  const id = randomUUID();
  const result = await getDb().query(
    `INSERT INTO sessions (id, agent_id, session_key, claude_session_id, mcp_hash, last_activity)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (agent_id, session_key) DO UPDATE
       SET claude_session_id = COALESCE(EXCLUDED.claude_session_id, sessions.claude_session_id),
           mcp_hash = COALESCE(EXCLUDED.mcp_hash, sessions.mcp_hash),
           last_activity = now()
     RETURNING *`,
    [id, agentId, sessionKey, claudeSessionId ?? null, mcpHash ?? null]
  );
  return rowToSession(result.rows[0]);
}

export async function cleanupStaleSessions(agentId: string, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = await getDb().query(
    'DELETE FROM sessions WHERE agent_id = $1 AND last_activity < $2',
    [agentId, cutoff]
  );
  return result.rowCount ?? 0;
}

// =============================================================================
// Scheduled Jobs
// =============================================================================

export async function getAllEnabledJobs(): Promise<ScheduledJob[]> {
  const r = await getDb().query('SELECT * FROM scheduled_jobs WHERE enabled = true');
  return r.rows.map(row => ({
    id: row.id as string,
    agentId: row.agent_id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    cronSchedule: row.cron_schedule as string,
    targetType: row.target_type as 'channel' | 'dm',
    targetId: row.target_id as string,
    enabled: row.enabled !== false && row.enabled !== 0,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  }));
}

export async function insertJobRun(jobId: string): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    "INSERT INTO job_runs (id, job_id, status) VALUES ($1, $2, 'running')",
    [id, jobId]
  );
  return id;
}

export async function updateJobRun(
  runId: string,
  status: 'success' | 'error',
  output?: string | null,
  error?: string | null
): Promise<void> {
  await getDb().query(
    'UPDATE job_runs SET status = $1, output = $2, error = $3, finished_at = now() WHERE id = $4',
    [status, output ?? null, error ?? null, runId]
  );
}

// =============================================================================
// Env Vars
// =============================================================================

export async function getAllEnvVarValues(): Promise<Record<string, string>> {
  const encKey = process.env.ENV_SECRET_KEY;
  if (!encKey) {
    logger.warn('ENV_SECRET_KEY not set — env var refs will not resolve');
    return {};
  }

  const r = await getDb().query('SELECT key, value FROM env_vars');
  const result: Record<string, string> = {};
  for (const row of r.rows) {
    try {
      result[row.key as string] = decrypt(row.value as string, encKey);
    } catch (err) {
      logger.warn('Failed to decrypt env var', { key: row.key, error: (err as Error).message });
    }
  }
  return result;
}

// =============================================================================
// Async result helper (namespaced settings row)
// =============================================================================

/** Write a result to the settings table with the exact key (no prefix). */
export async function setResult(key: string, value: string): Promise<void> {
  await getDb().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}
