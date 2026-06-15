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
    sensitivityCheck: (row.sensitivity_check as 'off' | 'deterministic' | 'smart') ?? 'deterministic',
    enforcementRedaction: row.enforcement_redaction === 1 || row.enforcement_redaction === true,
    redactionLevel: (row.redaction_level as 'secrets' | 'pii' | 'all') ?? 'secrets',
    sensitivityGuidance: (row.sensitivity_guidance as string) ?? '',
    reportsTo: (Array.isArray(row.reports_to) ? row.reports_to : []) as string[],
    claudeMd: (row.claude_md as string) ?? '',
    createdBy: (row.created_by as string) ?? 'system',
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lastError: (row.last_error as string | null | undefined) ?? null,
    runnerId: (row.runner_id as string | null | undefined) ?? null,
    lastHeartbeat: (row.last_heartbeat as string | null | undefined) ?? null,
    tags: (Array.isArray(row.tags) ? row.tags : []) as string[],
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
    createdBy: (row.created_by as string | undefined) ?? 'admin',
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
    description: (row.description as string | null) ?? null,
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

/**
 * Look up an agent by its Slack bot user ID.
 *
 * Used by the test-mode orchestrator to resolve `<@U...>` mentions in a boss
 * agent's output back to the SlackHive agent they refer to, so the
 * delegation chain can be simulated in test mode without Slack.
 *
 * Read-only: no writes, no caching. The DB is the source of truth and
 * the roster may change while a test session is open.
 */
export async function getAgentBySlackBotUserId(botUserId: string): Promise<Agent | null> {
  const r = await getDb().query(
    `SELECT a.* FROM agents a
     JOIN platform_integrations pi ON pi.agent_id = a.id
     WHERE pi.platform = $1 AND pi.bot_user_id = $2
     LIMIT 1`,
    ['slack', botUserId]
  );
  if (r.rows.length === 0) return null;
  const agent = rowToAgent(r.rows[0]);
  agent.slackBotUserId = botUserId;
  return agent;
}

/**
 * Returns a map of `slack_bot_user_id` → Agent for every SlackHive agent
 * with a Slack integration. Used by MessageHandler to scope the agent-
 * traffic bypass to trusted bots (other SlackHive agents) AND to enforce
 * the boss/reportee relationship — without this, any 3rd-party bot
 * (PagerDuty, GitHub, etc.) could trigger an agent by mentioning it, and
 * any SlackHive agent could trigger any other regardless of reportsTo.
 */
export async function getAgentsByBotUserId(): Promise<Map<string, Agent>> {
  const r = await getDb().query(
    `SELECT a.*, pi.bot_user_id FROM agents a
     JOIN platform_integrations pi ON pi.agent_id = a.id
     WHERE pi.platform = $1 AND pi.bot_user_id IS NOT NULL`,
    ['slack']
  );
  const out = new Map<string, Agent>();
  for (const row of r.rows) {
    const agent = rowToAgent(row);
    const botUserId = (row as Record<string, unknown>).bot_user_id as string;
    agent.slackBotUserId = botUserId;
    out.set(botUserId, agent);
  }
  return out;
}

export async function updateAgentStatus(
  id: string,
  status: AgentStatus,
  lastError?: string | null,
  runnerId?: string,
): Promise<void> {
  // When lastError is explicitly passed (even null) we also write it. When it's
  // undefined (default), the existing value is preserved — callers that don't
  // care about the error text shouldn't accidentally wipe it.
  //
  // When runnerId is provided, also stamp runner_id + last_heartbeat so the
  // read side can tell the owning runner's writes apart from stray ones.
  const setHeartbeat = runnerId !== undefined;
  const params: unknown[] = [status];
  const sets: string[] = ['status = $1'];

  if (lastError !== undefined) {
    sets.push(`last_error = $${params.length + 1}`);
    params.push(lastError);
  }
  if (setHeartbeat) {
    sets.push(`runner_id = $${params.length + 1}`);
    params.push(runnerId);
    sets.push(`last_heartbeat = now()`);
  }
  sets.push('updated_at = now()');

  params.push(id);
  await getDb().query(
    `UPDATE agents SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params,
  );
}

/**
 * Bump `last_heartbeat` for every agent this runner owns. Called on a timer
 * by AgentRunner so a crashed runner's "running" row decays and the UI can
 * render it as `stale` instead of a false-positive green.
 */
export async function heartbeatAgents(agentIds: string[], runnerId: string): Promise<void> {
  if (agentIds.length === 0) return;
  const placeholders = agentIds.map((_, i) => `$${i + 2}`).join(', ');
  await getDb().query(
    `UPDATE agents SET last_heartbeat = now(), runner_id = $1
     WHERE id IN (${placeholders}) AND status = 'running'`,
    [runnerId, ...agentIds],
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
    const { decrypt } = await import('@slackhive/shared');
    const { getEncryptionKey } = await import('./secrets.js');
    const creds = JSON.parse(decrypt(raw, getEncryptionKey()));
    return { credentials: creds, botUserId: row.bot_user_id as string | undefined };
  } catch (err) {
    console.error('[db] Failed to decrypt platform credentials — refusing plaintext fallback', err);
    return null;
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

/**
 * Loads a single skill by UUID. Used by the runner subscriber after a
 * `skill-saved` event so the summarizer can read the just-written content.
 */
export async function getSkillById(skillId: string): Promise<Skill | null> {
  const r = await getDb().query('SELECT * FROM skills WHERE id = $1', [skillId]);
  return r.rows[0] ? rowToSkill(r.rows[0]) : null;
}

/**
 * Updates only the `description` column of a skill. Does not bump
 * `updated_at` so a description fill from the summarizer doesn't look like a
 * content edit to snapshot/diff tooling.
 */
export async function updateSkillDescription(skillId: string, description: string | null): Promise<void> {
  await getDb().query('UPDATE skills SET description = $1 WHERE id = $2', [description, skillId]);
}

/**
 * Returns every skill across all agents whose description column is NULL.
 * Used by the backfill script so we only summarize rows that need it.
 */
export async function getSkillsMissingDescription(): Promise<Skill[]> {
  const r = await getDb().query(
    'SELECT * FROM skills WHERE description IS NULL ORDER BY agent_id, category, filename'
  );
  return r.rows.map(rowToSkill);
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

/** Drop a single session row so the next turn starts a fresh thread (used when a
 *  thread is poisoned — e.g. context overflow). upsertSession can't clear the id
 *  (its COALESCE keeps the old value), so an explicit delete is needed. */
export async function deleteSession(agentId: string, sessionKey: string): Promise<void> {
  await getDb().query(
    'DELETE FROM sessions WHERE agent_id = $1 AND session_key = $2',
    [agentId, sessionKey]
  );
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
    createdBy: (row.created_by as string) ?? 'system',
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  }));
}

/** Load one scheduled job by id (regardless of enabled state) — for manual "Run now". */
export async function getScheduledJobById(id: string): Promise<ScheduledJob | null> {
  const r = await getDb().query('SELECT * FROM scheduled_jobs WHERE id = $1', [id]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    cronSchedule: row.cron_schedule as string,
    targetType: row.target_type as 'channel' | 'dm',
    targetId: row.target_id as string,
    enabled: row.enabled !== false && row.enabled !== 0,
    createdBy: (row.created_by as string) ?? 'system',
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Mark any job_runs still 'running' as failed. Called on scheduler startup to
 * reconcile runs orphaned by a runner crash/restart (which can't write their own
 * terminal status). Returns the number of rows reconciled.
 */
export async function failOrphanedJobRuns(): Promise<number> {
  const r = await getDb().query(
    "UPDATE job_runs SET status = 'error', finished_at = now(), error = 'Interrupted by a runner restart' WHERE status = 'running'",
  );
  return r.rowCount ?? 0;
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

/**
 * Module-level cache for the decrypted env-var map. Without it, every agent
 * start re-runs `SELECT * FROM env_vars` and decrypts every row — even agents
 * that reference one key. 5min TTL with event-bus invalidation makes the
 * second-and-onward read effectively free.
 *
 * PERF_CACHES_ENABLED=0 disables the cache entirely.
 */
const ENV_CACHE_TTL_MS = 5 * 60_000;
/** Read fresh each call so toggling .env + restart isn't required. */
function envCacheEnabled(): boolean {
  return process.env.PERF_CACHES_ENABLED !== '0';
}
let envCache: { snapshot: Record<string, string>; expiresAt: number } | null = null;

/** Invalidate the env-var cache — called by the runner's event-bus subscriber on `env-vars-changed`. */
export function flushEnvVarsCache(): void {
  if (!envCacheEnabled()) return;
  envCache = null;
}

export async function getAllEnvVarValues(): Promise<Record<string, string>> {
  if (envCacheEnabled() && envCache && envCache.expiresAt > Date.now()) {
    return envCache.snapshot;
  }

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

  if (envCacheEnabled()) {
    envCache = { snapshot: result, expiresAt: Date.now() + ENV_CACHE_TTL_MS };
  }
  return result;
}

// =============================================================================
// Async result helper (namespaced settings row)
// =============================================================================

// =============================================================================
// Wiki Folders
// =============================================================================

export interface WikiFolderRef {
  id: string;
  name: string;
  slug: string; // URL-safe name slug for workdir subdir
}

export interface WikiSourceRow {
  id: string;
  folderId: string;
  type: string;
  name: string;
  content: string | null;
  url: string | null;
  repoUrl: string | null;
  branch: string;
  patEnvRef: string | null;
}

/** Returns wiki folders assigned to an agent, with a stable slug derived from name. */
export async function getAgentWikiFolders(agentId: string): Promise<WikiFolderRef[]> {
  const r = await getDb().query(
    `SELECT wf.id, wf.name
     FROM wiki_folders wf
     JOIN agent_wiki_folders awf ON awf.folder_id = wf.id
     WHERE awf.agent_id = $1
     ORDER BY wf.name ASC`,
    [agentId],
  );
  return r.rows.map(row => ({
    id: row.id as string,
    name: row.name as string,
    slug: (row.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  }));
}

/** Returns all sources for a wiki folder. */
export async function getWikiFolderSources(folderId: string): Promise<WikiSourceRow[]> {
  const r = await getDb().query(
    `SELECT id, folder_id, type, name, content, url, repo_url, branch, pat_env_ref
     FROM wiki_sources WHERE folder_id = $1`,
    [folderId],
  );
  return r.rows.map(row => ({
    id: row.id as string,
    folderId: row.folder_id as string,
    type: row.type as string,
    name: row.name as string,
    content: row.content as string | null,
    url: row.url as string | null,
    repoUrl: row.repo_url as string | null,
    branch: (row.branch as string | null) ?? 'main',
    patEnvRef: row.pat_env_ref as string | null,
  }));
}

/** Update the status (and optionally wordCount/lastSynced) of a wiki source. */
export async function updateWikiSourceStatus(
  sourceId: string,
  status: string,
  wordCount?: number,
  lastSynced?: string,
): Promise<void> {
  const sets: string[] = ['status = $1'];
  const vals: unknown[] = [status];
  let i = 2;
  if (wordCount !== undefined) { sets.push(`word_count = $${i++}`); vals.push(wordCount); }
  if (lastSynced !== undefined) { sets.push(`last_synced = $${i++}`); vals.push(lastSynced); }
  vals.push(sourceId);
  await getDb().query(`UPDATE wiki_sources SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

/** Read a single setting by key. Returns null if not set. */
export async function getSetting(key: string): Promise<string | null> {
  const r = await getDb().query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows.length > 0 ? (r.rows[0] as { value: string }).value : null;
}

/** Write a result to the settings table with the exact key (no prefix). */
export async function setResult(key: string, value: string): Promise<void> {
  await getDb().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

/** Upsert a setting value by exact key (used to persist refreshed credentials). */
export async function setSetting(key: string, value: string): Promise<void> {
  await getDb().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

/** Epoch-ms timestamp of a setting's last write, or null if absent. */
export async function getSettingUpdatedAt(key: string): Promise<number | null> {
  const r = await getDb().query('SELECT updated_at FROM settings WHERE key = $1', [key]);
  if (!r.rows.length) return null;
  const v = (r.rows[0] as { updated_at: string | number | Date | null }).updated_at;
  if (v == null) return null;
  // SQLite's datetime('now') is UTC but has no timezone marker, so `new Date()`
  // would parse it as LOCAL time and skew the comparison. Normalize to UTC.
  let t: number;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
    t = Date.parse(v.replace(' ', 'T') + 'Z');
  } else {
    t = new Date(v as string | number | Date).getTime();
  }
  return Number.isNaN(t) ? null : t;
}
