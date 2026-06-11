/**
 * @fileoverview Repository for the activity dashboard — `tasks`, `activities`,
 * `tool_calls`.
 *
 * A **task** is one messaging-platform thread. Every agent that replies into the
 * same thread appends an **activity** row; every SDK tool invocation inside an
 * activity appends a **tool_call** row. This is the write-side for the data
 * layer feature-flagged by `ACTIVITY_DASHBOARD`.
 *
 * All writes are best-effort — a failure here must never break the Slack hot
 * path. Callers wrap these in try/catch; when the flag is off the hooks
 * short-circuit before touching this module at all.
 *
 * @module @slackhive/shared/db/activities-repo
 */

import { randomUUID } from 'crypto';
import { getDb } from './adapter';
import type {
  Activity,
  ActivityFilter,
  ActivityStatus,
  Platform,
  Task,
  ToolCall,
  ToolCallStatus,
} from '../types';

// =============================================================================
// Preview helpers
// =============================================================================

const PREVIEW_LIMIT = 200;

/** Truncate text to `PREVIEW_LIMIT` characters, preserving null/undefined. */
function truncate(text: string | null | undefined, max = PREVIEW_LIMIT): string | null {
  if (text == null) return null;
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

/** Build the deterministic task id for a platform thread. */
function buildTaskId(platform: Platform, channelId: string, threadTs: string): string {
  return `${platform}:${channelId}:${threadTs}`;
}

// =============================================================================
// Row mappers
// =============================================================================

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    platform: row.platform as Platform,
    channelId: row.channel_id as string,
    threadTs: row.thread_ts as string,
    initiatorUserId: (row.initiator_user_id as string | null) ?? undefined,
    initiatorHandle: (row.initiator_handle as string | null) ?? undefined,
    initialAgentId: (row.initial_agent_id as string | null) ?? undefined,
    summary: (row.summary as string | null) ?? undefined,
    startedAt: row.started_at as string,
    lastActivityAt: row.last_activity_at as string,
    activityCount: Number(row.activity_count ?? 0),
    sensitive: row.sensitive ? true : undefined,
  };
}

function rowToActivity(row: Record<string, unknown>): Activity {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    agentId: row.agent_id as string,
    platform: row.platform as Platform,
    initiatorKind: row.initiator_kind as Activity['initiatorKind'],
    initiatorUserId: (row.initiator_user_id as string | null) ?? undefined,
    messageRef: (row.message_ref as string | null) ?? undefined,
    messagePreview: (row.message_preview as string | null) ?? undefined,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? undefined,
    status: row.status as ActivityStatus,
    error: (row.error as string | null) ?? undefined,
    toolCallCount: Number(row.tool_call_count ?? 0),
    inputTokens: row.input_tokens == null ? undefined : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? undefined : Number(row.output_tokens),
    cacheReadTokens: row.cache_read_tokens == null ? undefined : Number(row.cache_read_tokens),
    cacheCreationTokens: row.cache_creation_tokens == null ? undefined : Number(row.cache_creation_tokens),
  };
}

function rowToToolCall(row: Record<string, unknown>): ToolCall {
  return {
    id: row.id as string,
    activityId: row.activity_id as string,
    toolName: row.tool_name as string,
    argsPreview: (row.args_preview as string | null) ?? undefined,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? undefined,
    status: row.status as ToolCallStatus,
    resultPreview: (row.result_preview as string | null) ?? undefined,
  };
}

// =============================================================================
// Writer API
// =============================================================================

export interface UpsertTaskInput {
  platform: Platform;
  channelId: string;
  threadTs: string;
  initiatorUserId?: string;
  initiatorHandle?: string;
  initialAgentId?: string;
  openingPreview?: string;
}

/**
 * Create a task row if the `{platform, channelId, threadTs}` combination is
 * new, otherwise no-op. Returns the task id either way.
 *
 * The opening fields (`initiatorUserId`, `summary`, `initialAgentId`) are only
 * set on first insert — later messages into the same thread don't overwrite
 * them, so the card always reflects who kicked the thread off.
 */
export async function upsertTask(input: UpsertTaskInput): Promise<string> {
  const id = buildTaskId(input.platform, input.channelId, input.threadTs);
  const db = getDb();
  await db.query(
    `INSERT INTO tasks (
       id, platform, channel_id, thread_ts,
       initiator_user_id, initiator_handle, initial_agent_id, summary
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (platform, channel_id, thread_ts) DO NOTHING`,
    [
      id,
      input.platform,
      input.channelId,
      input.threadTs,
      input.initiatorUserId ?? null,
      input.initiatorHandle ?? null,
      input.initialAgentId ?? null,
      truncate(input.openingPreview),
    ],
  );
  return id;
}

export interface BeginActivityInput {
  taskId: string;
  agentId: string;
  platform: Platform;
  initiatorKind: Activity['initiatorKind'];
  initiatorUserId?: string;
  initiatorHandle?: string;
  messageRef?: string;
  messagePreview?: string;
}

/** Insert an activity row in `status='in_progress'` and return its id. */
export async function beginActivity(input: BeginActivityInput): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  await db.query(
    `INSERT INTO activities (
       id, task_id, agent_id, platform,
       initiator_kind, initiator_user_id, initiator_handle,
       message_ref, message_preview, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'in_progress')`,
    [
      id,
      input.taskId,
      input.agentId,
      input.platform,
      input.initiatorKind,
      input.initiatorUserId ?? null,
      input.initiatorHandle ?? null,
      input.messageRef ?? null,
      truncate(input.messagePreview),
    ],
  );
  // Bump the task summary counters. We do this on begin (not finish) so the
  // dashboard sees in-flight work immediately.
  await db.query(
    `UPDATE tasks
        SET last_activity_at = datetime('now'),
            activity_count   = activity_count + 1
      WHERE id = $1`,
    [input.taskId],
  );
  return id;
}

/**
 * Mark an activity finished. On 'error' the caller may pass an `error`
 * message; any dangling `in_progress` tool_calls for this activity are
 * closed out as `'error'` so the dashboard never shows orphaned rows.
 */
export async function finishActivity(
  activityId: string,
  status: Exclude<ActivityStatus, 'in_progress'>,
  error?: string,
): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE activities
        SET status = $1, error = $2, finished_at = datetime('now')
      WHERE id = $3`,
    [status, error ?? null, activityId],
  );
  // Close any tool_calls that were never finished — typical on abort / error.
  await db.query(
    `UPDATE tool_calls
        SET status = 'error', finished_at = datetime('now')
      WHERE activity_id = $1 AND status = 'in_progress'`,
    [activityId],
  );
  // Keep the task's last_activity_at fresh on finish too, so cards move from
  // Active to Recent using the completion time.
  await db.query(
    `UPDATE tasks
        SET last_activity_at = datetime('now')
      WHERE id = (SELECT task_id FROM activities WHERE id = $1)`,
    [activityId],
  );
}

export interface BeginToolCallInput {
  activityId: string;
  toolName: string;
  argsPreview?: string;
}

/** Insert a tool_call row in `status='in_progress'` and return its id. */
export async function beginToolCall(input: BeginToolCallInput): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  await db.query(
    `INSERT INTO tool_calls (id, activity_id, tool_name, args_preview, status)
     VALUES ($1, $2, $3, $4, 'in_progress')`,
    [id, input.activityId, input.toolName, truncate(input.argsPreview)],
  );
  await db.query(
    `UPDATE activities
        SET tool_call_count = tool_call_count + 1
      WHERE id = $1`,
    [input.activityId],
  );
  return id;
}

/** Mark a tool_call finished with its result (or error message). */
export async function finishToolCall(
  toolCallId: string,
  status: Exclude<ToolCallStatus, 'in_progress'>,
  resultPreview?: string,
): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE tool_calls
        SET status = $1, result_preview = $2, finished_at = datetime('now')
      WHERE id = $3`,
    [status, truncate(resultPreview), toolCallId],
  );
}

/** SDK `result` message usage shape — matches `@anthropic-ai/claude-agent-sdk`. */
export interface ActivityUsageInput {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Persist per-turn token usage on an activity row. Called once per SDK `result`
 * message. Missing/null fields are coerced to 0 — NULL is reserved for rows
 * that pre-date this feature.
 */
export async function recordActivityUsage(
  activityId: string,
  usage: ActivityUsageInput,
): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE activities
        SET input_tokens          = $1,
            output_tokens         = $2,
            cache_read_tokens     = $3,
            cache_creation_tokens = $4
      WHERE id = $5`,
    [
      Number(usage.input_tokens ?? 0),
      Number(usage.output_tokens ?? 0),
      Number(usage.cache_read_input_tokens ?? 0),
      Number(usage.cache_creation_input_tokens ?? 0),
      activityId,
    ],
  );
}

// =============================================================================
// Reader API
// =============================================================================

/** Which kanban column to fetch. */
export type TaskListColumn = 'active' | 'recent' | 'errored';

export interface TaskListResult {
  tasks: Task[];
  /** Next page cursor — `{lastActivityAt}|{taskId}`. `null` when there are no more rows. */
  nextCursor: string | null;
}

/**
 * List tasks for one kanban column.
 *
 * `active` — tasks with at least one `activities.status='in_progress'` row.
 * `recent` — tasks with no in-flight activity and no errored activity.
 * `errored` — tasks whose most-recent activity is `error`.
 *
 * `cursor` pagination is `{lastActivityAt}|{taskId}`, descending — stable even
 * when multiple tasks share the same `last_activity_at`.
 */
export async function listTasks(
  column: TaskListColumn,
  filter: ActivityFilter = {},
  limit = 20,
  cursor: string | null = null,
): Promise<TaskListResult> {
  const db = getDb();

  if (filter.accessibleAgentIds !== undefined && filter.accessibleAgentIds.length === 0) {
    return { tasks: [], nextCursor: null };
  }

  // Build CTE params first (agent/access filters go into the CTE),
  // then task-level params (user, since, cursor, limit).
  const cteParams: unknown[] = [];
  const taskWheres: string[] = [];
  const taskParams: unknown[] = [];

  // CTE filters — narrow activities before aggregation
  const cteWheres: string[] = [];

  if (filter.agentId) {
    cteWheres.push(`agent_id = $${cteParams.length + 1}`);
    cteParams.push(filter.agentId);
  }

  if (filter.accessibleAgentIds !== undefined) {
    const placeholders = filter.accessibleAgentIds
      .map((_, i) => `$${cteParams.length + 1 + i}`)
      .join(', ');
    cteWheres.push(`agent_id IN (${placeholders})`);
    cteParams.push(...filter.accessibleAgentIds);
  }

  // Time window filters the ACTIVITIES (by started_at), not the task's
  // last_activity_at — so a task is listed when it has a turn in the window,
  // matching how the usage/stats aggregates scope the same range. (Otherwise a
  // custom range's upper bound could hide a task from the list while its in-range
  // turn still shows in the totals.)
  if (filter.since) {
    cteWheres.push(`started_at >= $${cteParams.length + 1}`);
    cteParams.push(filter.since);
  }
  if (filter.until) {
    cteWheres.push(`started_at <= $${cteParams.length + 1}`);
    cteParams.push(filter.until);
  }

  const cteWhereSql = cteWheres.length ? `WHERE ${cteWheres.join(' AND ')}` : '';

  // Task-level filters
  if (filter.userId) {
    taskWheres.push(`t.initiator_user_id = $${cteParams.length + taskParams.length + 1}`);
    taskParams.push(filter.userId);
  }

  // (since/until are applied in the CTE above, on activity started_at.)

  // Column filter against pre-aggregated CTE columns
  if (column === 'active') {
    taskWheres.push(`agg.has_active = 1`);
  } else if (column === 'recent') {
    taskWheres.push(`agg.has_active = 0 AND agg.latest_status = 'done'`);
  } else if (column === 'errored') {
    taskWheres.push(`agg.has_active = 0 AND agg.latest_status = 'error'`);
  }

  // Cursor pagination
  if (cursor) {
    const [cursorTs, cursorId] = cursor.split('|', 2);
    if (cursorTs && cursorId) {
      const p1 = cteParams.length + taskParams.length + 1;
      taskWheres.push(`(t.last_activity_at < $${p1} OR (t.last_activity_at = $${p1} AND t.id < $${p1 + 1}))`);
      taskParams.push(cursorTs, cursorId);
    }
  }

  const taskWhereSql = taskWheres.length ? `AND ${taskWheres.join(' AND ')}` : '';
  const allParams = [...cteParams, ...taskParams];
  const limitIdx = allParams.length + 1;
  allParams.push(limit + 1);

  // Single-pass CTE: aggregate per-task activity status in one scan.
  // has_active: 1 if any activity is in_progress
  // latest_status: status of the most recent activity by started_at
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT task_id, status,
              MAX(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) OVER (PARTITION BY task_id) AS has_active,
              ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC, id DESC) AS rn
       FROM activities a
       ${cteWhereSql}
     ),
     agg AS (
       SELECT task_id, has_active, status AS latest_status
       FROM ranked WHERE rn = 1
     )
     SELECT t.*,
            EXISTS(SELECT 1 FROM spans s WHERE s.session_id = t.id AND s.sensitive = 1) AS sensitive
       FROM tasks t
       JOIN agg ON agg.task_id = t.id
      WHERE 1=1 ${taskWhereSql}
      ORDER BY t.last_activity_at DESC, t.id DESC
      LIMIT $${limitIdx}`,
    allParams,
  );

  const tasks = rows.slice(0, limit).map(rowToTask);
  const hasMore = rows.length > limit;
  const nextCursor = hasMore && tasks.length > 0
    ? `${tasks[tasks.length - 1].lastActivityAt}|${tasks[tasks.length - 1].id}`
    : null;

  return { tasks, nextCursor };
}

/** A task with its activities and each activity's tool calls — for the detail view. */
export interface TaskWithDetails {
  task: Task;
  activities: (Activity & { toolCalls: ToolCall[] })[];
}

/** Fetch one task with all its activities and their tool calls. */
export async function getTaskWithDetails(taskId: string): Promise<TaskWithDetails | null> {
  const db = getDb();
  const taskRes = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (taskRes.rows.length === 0) return null;
  const task = rowToTask(taskRes.rows[0]);

  const actRes = await db.query(
    `SELECT * FROM activities WHERE task_id = $1 ORDER BY started_at ASC, id ASC`,
    [taskId],
  );
  const activities = actRes.rows.map(rowToActivity);

  if (activities.length === 0) return { task, activities: [] };

  const placeholders = activities.map((_, i) => `$${i + 1}`).join(', ');
  const tcRes = await db.query(
    `SELECT * FROM tool_calls WHERE activity_id IN (${placeholders})
     ORDER BY started_at ASC, id ASC`,
    activities.map(a => a.id),
  );
  const byActivity = new Map<string, ToolCall[]>();
  for (const row of tcRes.rows) {
    const tc = rowToToolCall(row);
    const bucket = byActivity.get(tc.activityId) ?? [];
    bucket.push(tc);
    byActivity.set(tc.activityId, bucket);
  }

  return {
    task,
    activities: activities.map(a => ({ ...a, toolCalls: byActivity.get(a.id) ?? [] })),
  };
}

/**
 * Count in-progress activities per agent. Feeds the "Replying" chip on the
 * main dashboard's agent cards.
 *
 * If `accessibleAgentIds` is provided, counts are restricted to those agents
 * (empty array yields an empty map).
 */
export async function countInProgressByAgent(
  accessibleAgentIds?: string[],
): Promise<Record<string, number>> {
  if (accessibleAgentIds !== undefined && accessibleAgentIds.length === 0) {
    return {};
  }
  const db = getDb();
  const params: unknown[] = [];
  let whereExtra = '';
  if (accessibleAgentIds !== undefined) {
    const placeholders = accessibleAgentIds.map((_, i) => `$${i + 1}`).join(', ');
    whereExtra = ` AND agent_id IN (${placeholders})`;
    params.push(...accessibleAgentIds);
  }
  const { rows } = await db.query(
    `SELECT agent_id, COUNT(*) AS n
       FROM activities
      WHERE status = 'in_progress'${whereExtra}
      GROUP BY agent_id`,
    params,
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.agent_id as string] = Number(row.n ?? 0);
  }
  return out;
}

/**
 * Mark any activities/tool_calls that are still `in_progress` as `error` and
 * return the swept activity IDs so the caller can decide whether to auto-
 * replay them. Called once at runner startup to recover from unclean
 * shutdowns (SIGKILL, crashes) that bypassed the normal closeActivity path.
 */
export async function sweepStaleActivities(): Promise<string[]> {
  const db = getDb();
  await db.query(
    `UPDATE tool_calls SET status = 'ok'
      WHERE status = 'in_progress'`,
    [],
  );
  const { rows } = await db.query(
    `UPDATE activities
        SET status = 'error', error = 'Interrupted — runner restarted',
            finished_at = datetime('now')
      WHERE status = 'in_progress'
  RETURNING id`,
    [],
  );
  return rows.map(r => r.id as string);
}

// =============================================================================
// Usage aggregation
// =============================================================================

export interface AgentTokenUsage {
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turnCount: number;
}

export interface UserActivitySummary {
  userId: string;
  handle: string | null;
  taskCount: number;
  turnCount: number;
  totalTokens: number;
}

/**
 * Render a bare SQLite `IN (…)` clause for the accessible-agent allowlist —
 * the caller decides whether to join it with `AND` or prepend it.
 *
 * Returns `null` when there are no accessible agents (caller should short-circuit
 * to an empty result), `{ sql: '', params: [] }` for admin callers (no restriction),
 * or `{ sql: 'a.agent_id IN (...)', params: [...] }` when there is a restriction.
 */
function accessClause(
  accessibleAgentIds: string[] | undefined,
  startIdx: number,
): { sql: string; params: unknown[] } | null {
  if (accessibleAgentIds === undefined) return { sql: '', params: [] };
  if (accessibleAgentIds.length === 0) return null;
  const placeholders = accessibleAgentIds.map((_, i) => `$${startIdx + i}`).join(', ');
  return { sql: `a.agent_id IN (${placeholders})`, params: [...accessibleAgentIds] };
}

/** Sum token columns per agent within the filter window. Sorted by descending total. */
export async function getTokensByAgent(filter: ActivityFilter = {}): Promise<AgentTokenUsage[]> {
  const db = getDb();
  const wheres: string[] = [];
  const params: unknown[] = [];

  if (filter.since) {
    wheres.push(`a.started_at >= $${params.length + 1}`);
    params.push(filter.since);
  }
  if (filter.until) {
    wheres.push(`a.started_at <= $${params.length + 1}`);
    params.push(filter.until);
  }

  if (filter.agentId) {
    wheres.push(`a.agent_id = $${params.length + 1}`);
    params.push(filter.agentId);
  }

  const access = accessClause(filter.accessibleAgentIds, params.length + 1);
  if (access === null) return [];
  if (access.sql) {
    wheres.push(access.sql);
    params.push(...access.params);
  }

  const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT a.agent_id                                  AS agent_id,
            COALESCE(SUM(a.input_tokens), 0)            AS input_tokens,
            COALESCE(SUM(a.output_tokens), 0)           AS output_tokens,
            COALESCE(SUM(a.cache_read_tokens), 0)       AS cache_read_tokens,
            COALESCE(SUM(a.cache_creation_tokens), 0)   AS cache_creation_tokens,
            COUNT(*)                                     AS turn_count
       FROM activities a
       ${whereSql}
      GROUP BY a.agent_id
      ORDER BY (COALESCE(SUM(a.input_tokens), 0) + COALESCE(SUM(a.output_tokens), 0)) DESC`,
    params,
  );

  return rows.map(row => ({
    agentId: row.agent_id as string,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheCreationTokens: Number(row.cache_creation_tokens ?? 0),
    turnCount: Number(row.turn_count ?? 0),
  }));
}

/**
 * Top N users by distinct task count within the filter window. Ties broken
 * by total token spend, then turn count, both descending. Tokens are the
 * tiebreaker (not turns) because this powers the billing-adjacent Usage
 * dashboard — a 2-task user burning 111K tokens is a heavier user than a
 * 2-task user with more turns but a fraction of the tokens.
 *
 * Excludes rows with no initiator_user_id. All counts filter on
 * `a.started_at` so totals match the per-agent bars in the same window.
 */
export async function getTopUsers(
  filter: ActivityFilter = {},
  limit = 10,
): Promise<UserActivitySummary[]> {
  const db = getDb();
  const wheres: string[] = [`t.initiator_user_id IS NOT NULL`];
  const params: unknown[] = [];

  if (filter.since) {
    wheres.push(`a.started_at >= $${params.length + 1}`);
    params.push(filter.since);
  }
  if (filter.until) {
    wheres.push(`a.started_at <= $${params.length + 1}`);
    params.push(filter.until);
  }

  if (filter.agentId) {
    wheres.push(`a.agent_id = $${params.length + 1}`);
    params.push(filter.agentId);
  }

  const access = accessClause(filter.accessibleAgentIds, params.length + 1);
  if (access === null) return [];
  if (access.sql) {
    wheres.push(access.sql);
    params.push(...access.params);
  }

  params.push(limit);

  // MAX(initiator_handle) is a SQLite-idiomatic way to pull any one handle
  // for the grouped user — we only store one handle per task, so it's
  // effectively "pick the lexicographically largest" (stable, arbitrary).
  const { rows } = await db.query(
    `SELECT t.initiator_user_id                                      AS user_id,
            MAX(t.initiator_handle)                                  AS handle,
            COUNT(DISTINCT t.id)                                     AS task_count,
            COUNT(a.id)                                              AS turn_count,
            COALESCE(SUM(COALESCE(a.input_tokens, 0) + COALESCE(a.output_tokens, 0)), 0) AS total_tokens
       FROM tasks t
       JOIN activities a ON a.task_id = t.id
      WHERE ${wheres.join(' AND ')}
      GROUP BY t.initiator_user_id
      ORDER BY task_count DESC, total_tokens DESC, turn_count DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map(row => ({
    userId: row.user_id as string,
    handle: (row.handle as string | null) ?? null,
    taskCount: Number(row.task_count ?? 0),
    turnCount: Number(row.turn_count ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
  }));
}

// =============================================================================
// Message feedback (👍/👎 on an agent's final reply)
// =============================================================================

export interface MessageFeedbackInput {
  agentId: string;
  activityId?: string | null;
  channel?: string | null;
  messageTs?: string | null;
  raterUserId?: string | null;
  raterHandle?: string | null;
  sentiment: 'up' | 'down';
  note?: string | null;
  /** Slack permalink to the rated reply's thread (for the report-card link). */
  permalink?: string | null;
}

/** One rating in the report-card list (both 👍 and 👎). */
export interface FeedbackRating {
  sentiment: 'up' | 'down';
  raterHandle: string | null;
  note: string | null;
  permalink: string | null;
  createdAt: string;
  /** Session (task) the rated turn belongs to — links to the trace view.
   * Null for older ratings whose activity link is missing. */
  sessionId: string | null;
}

export interface AgentFeedbackReport {
  up: number;
  down: number;
  total: number;
  /** Satisfaction = up / (up + down), 0–100. 0 when no ratings. */
  scorePercent: number;
  /** Total ratings matching the sentiment filter (for "Load more" pagination). */
  ratingCount: number;
  /** This page of ratings (newest first), honoring the sentiment filter. */
  recentRatings: FeedbackRating[];
}

/**
 * Record one 👍/👎 rating, keyed by (message_ts, rater_user_id) so a user
 * re-rating the same message updates their row. The 👎 modal calls this again
 * with the note, which is merged onto the existing row. Best-effort — never
 * break the Slack interaction path.
 */
/** Record which posted reply (Slack message ts) belongs to an activity, so a later
 *  feedback click can resolve the turn durably (survives a runner restart). */
export async function linkActivityReply(activityId: string, replyTs: string): Promise<void> {
  await getDb().query(`UPDATE activities SET reply_ts = $1 WHERE id = $2`, [replyTs, activityId]);
}

/** Resolve the activity a reply belongs to, by the reply's Slack message ts. */
export async function findActivityIdByReply(replyTs: string): Promise<string | null> {
  const { rows } = await getDb().query(
    `SELECT id FROM activities WHERE reply_ts = $1 ORDER BY started_at DESC LIMIT 1`,
    [replyTs],
  );
  return rows.length ? (rows[0].id as string) : null;
}

export async function recordMessageFeedback(input: MessageFeedbackInput): Promise<void> {
  const db = getDb();
  const id = randomUUID();
  await db.query(
    `INSERT INTO message_feedback
       (id, agent_id, activity_id, channel, message_ts, rater_user_id, rater_handle, sentiment, note, permalink)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (message_ts, rater_user_id) DO UPDATE SET
       sentiment  = excluded.sentiment,
       note       = COALESCE(excluded.note, message_feedback.note),
       permalink  = COALESCE(excluded.permalink, message_feedback.permalink),
       created_at = datetime('now')`,
    [
      id, input.agentId, input.activityId ?? null, input.channel ?? null,
      input.messageTs ?? null, input.raterUserId ?? null, input.raterHandle ?? null,
      input.sentiment, input.note ?? null, input.permalink ?? null,
    ],
  );
}

/**
 * Per-agent feedback summary (satisfaction score, counts) + a page of ratings.
 * The summary counts always cover all sentiments in the window; the ratings list
 * honors the optional `sentiment` filter. `limit`/`offset` paginate the list
 * (`limit === 0` → counts only, e.g. the Overview); `ratingCount` is the total
 * matching the filter so the UI knows whether to show "Load more".
 *
 * On paginated requests (`offset > 0`) the summary is skipped — the caller
 * already has it from the first page — so a "Load more" only runs the list query.
 */
export async function getFeedbackReport(
  agentId: string,
  opts: { since?: string; sentiment?: 'up' | 'down'; limit?: number; offset?: number } = {},
): Promise<AgentFeedbackReport> {
  const db = getDb();
  const rawLimit = Number.isFinite(opts.limit) ? (opts.limit as number) : 5;
  const wantList = rawLimit !== 0;
  const limit = Math.min(Math.max(rawLimit || 5, 1), 50);
  const offset = Math.max(Number.isFinite(opts.offset) ? (opts.offset as number) : 0, 0);
  const wantSummary = offset === 0;

  // Summary scope: agent + window (NOT the sentiment filter — the score reflects
  // all ratings in the window).
  const wheres = ['agent_id = $1'];
  const params: unknown[] = [agentId];
  if (opts.since) {
    wheres.push(`created_at >= $${params.length + 1}`);
    params.push(opts.since);
  }

  let up = 0, down = 0, total = 0;
  if (wantSummary) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN sentiment = 'up'   THEN 1 ELSE 0 END), 0) AS up_count,
              COALESCE(SUM(CASE WHEN sentiment = 'down' THEN 1 ELSE 0 END), 0) AS down_count,
              COUNT(*) AS total
         FROM message_feedback
        WHERE ${wheres.join(' AND ')}`,
      params,
    );
    const r = rows[0] ?? {};
    up = Number(r.up_count ?? 0);
    down = Number(r.down_count ?? 0);
    total = Number(r.total ?? 0);
  }
  const scorePercent = up + down === 0 ? 0 : Math.round((up / (up + down)) * 100);

  // List scope: summary scope + sentiment filter. The filtered total is derived
  // from the counts above — no extra count query needed (0 on paginated calls,
  // where the caller keeps the first page's ratingCount).
  const ratingCount = opts.sentiment === 'up' ? up : opts.sentiment === 'down' ? down : total;

  let recentRatings: FeedbackRating[] = [];
  if (wantList) {
    // Join activities to resolve the session (task) id for the "View session"
    // link. Columns are f-qualified since agent_id exists on both tables.
    const listWheres = [`f.agent_id = $1`];
    const listParams: unknown[] = [agentId];
    if (opts.since) { listWheres.push(`f.created_at >= $${listParams.length + 1}`); listParams.push(opts.since); }
    if (opts.sentiment) { listWheres.push(`f.sentiment = $${listParams.length + 1}`); listParams.push(opts.sentiment); }
    const listRes = await db.query(
      `SELECT f.sentiment, f.rater_handle, f.note, f.permalink, f.created_at, a.task_id
         FROM message_feedback f
         LEFT JOIN activities a ON a.id = f.activity_id
        WHERE ${listWheres.join(' AND ')}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
      [...listParams, limit, offset],
    );
    recentRatings = listRes.rows.map(n => ({
      sentiment: n.sentiment as 'up' | 'down',
      raterHandle: (n.rater_handle as string | null) ?? null,
      note: (n.note as string | null) ?? null,
      permalink: (n.permalink as string | null) ?? null,
      createdAt: n.created_at as string,
      sessionId: (n.task_id as string | null) ?? null,
    }));
  }

  return { up, down, total, scorePercent, ratingCount, recentRatings };
}

