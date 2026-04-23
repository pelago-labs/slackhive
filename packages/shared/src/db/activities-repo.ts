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
       initiator_kind, initiator_user_id,
       message_ref, message_preview, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress')`,
    [
      id,
      input.taskId,
      input.agentId,
      input.platform,
      input.initiatorKind,
      input.initiatorUserId ?? null,
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
  const wheres: string[] = [];
  const params: unknown[] = [];

  // Column-specific filter against subqueries over `activities`.
  if (column === 'active') {
    wheres.push(`EXISTS (
      SELECT 1 FROM activities a
       WHERE a.task_id = tasks.id AND a.status = 'in_progress'
    )`);
  } else if (column === 'recent') {
    wheres.push(`NOT EXISTS (
      SELECT 1 FROM activities a
       WHERE a.task_id = tasks.id AND a.status = 'in_progress'
    )`);
    wheres.push(`NOT EXISTS (
      SELECT 1 FROM activities a
       WHERE a.task_id = tasks.id AND a.status = 'error'
    )`);
  } else if (column === 'errored') {
    wheres.push(`EXISTS (
      SELECT 1 FROM activities a
       WHERE a.task_id = tasks.id AND a.status = 'error'
    )`);
  }

  if (filter.agentId) {
    wheres.push(`EXISTS (
      SELECT 1 FROM activities a
       WHERE a.task_id = tasks.id AND a.agent_id = $${params.length + 1}
    )`);
    params.push(filter.agentId);
  }

  if (filter.userId) {
    wheres.push(`tasks.initiator_user_id = $${params.length + 1}`);
    params.push(filter.userId);
  }

  if (filter.since) {
    wheres.push(`tasks.last_activity_at >= $${params.length + 1}`);
    params.push(filter.since);
  }

  if (filter.accessibleAgentIds !== undefined) {
    if (filter.accessibleAgentIds.length === 0) {
      // User can access no agents — short-circuit to empty.
      return { tasks: [], nextCursor: null };
    }
    const placeholders = filter.accessibleAgentIds
      .map((_, i) => `$${params.length + 1 + i}`)
      .join(', ');
    wheres.push(`EXISTS (
      SELECT 1 FROM activities a
       WHERE a.task_id = tasks.id AND a.agent_id IN (${placeholders})
    )`);
    params.push(...filter.accessibleAgentIds);
  }

  if (cursor) {
    const [cursorTs, cursorId] = cursor.split('|', 2);
    if (cursorTs && cursorId) {
      // Stable descending pagination — ties broken by task id.
      wheres.push(
        `(tasks.last_activity_at < $${params.length + 1}
          OR (tasks.last_activity_at = $${params.length + 1} AND tasks.id < $${params.length + 2}))`,
      );
      params.push(cursorTs, cursorId);
    }
  }

  const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  const limitIdx = params.length + 1;
  params.push(limit + 1); // over-fetch by 1 to detect next page

  const { rows } = await db.query(
    `SELECT *
       FROM tasks
       ${whereSql}
      ORDER BY tasks.last_activity_at DESC, tasks.id DESC
      LIMIT $${limitIdx}`,
    params,
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
