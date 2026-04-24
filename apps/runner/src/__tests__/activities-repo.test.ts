/**
 * @fileoverview Unit tests for the activities-repo writer + reader.
 *
 * Uses a throwaway on-disk SQLite DB per test (in a temp dir) so we run
 * against the real adapter, including the UUID triggers and CHECK
 * constraints — mocks would hide schema-level bugs we care about here.
 *
 * @module runner/__tests__/activities-repo.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteAdapter,
  setDb,
  getDb,
  closeDb,
  upsertTask,
  beginActivity,
  finishActivity,
  beginToolCall,
  finishToolCall,
  listTasks,
  getTaskWithDetails,
  countInProgressByAgent,
  recordActivityUsage,
  getTokensByAgent,
  getTopUsers,
} from '@slackhive/shared';

let dbPath: string;

async function seedAgent(id = randomUUID()): Promise<string> {
  const db = getDb();
  await db.query(
    `INSERT INTO agents (id, slug, name, persona, description, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, `slug-${id.slice(0, 8)}`, 'Test Agent', null, null, 'claude-opus-4-7'],
  );
  return id;
}

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activities-repo-'));
  dbPath = path.join(tmpDir, 'data.db');
  const adapter = createSqliteAdapter(dbPath);
  setDb(adapter);
});

afterEach(async () => {
  await closeDb();
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('upsertTask', () => {
  it('inserts on first call and no-ops on repeat', async () => {
    const id1 = await upsertTask({
      platform: 'slack',
      channelId: 'C1',
      threadTs: '100.0',
      initiatorUserId: 'U1',
      openingPreview: 'hello',
    });
    const id2 = await upsertTask({
      platform: 'slack',
      channelId: 'C1',
      threadTs: '100.0',
      initiatorUserId: 'U_different',
      openingPreview: 'second call',
    });
    expect(id1).toBe(id2);
    expect(id1).toBe('slack:C1:100.0');

    const { rows } = await getDb().query(`SELECT * FROM tasks WHERE id = $1`, [id1]);
    expect(rows).toHaveLength(1);
    // First-insert fields win
    expect(rows[0].initiator_user_id).toBe('U1');
    expect(rows[0].summary).toBe('hello');
  });

  it('truncates long previews to 200 chars', async () => {
    const long = 'x'.repeat(500);
    const id = await upsertTask({
      platform: 'slack',
      channelId: 'C2',
      threadTs: '200.0',
      openingPreview: long,
    });
    const { rows } = await getDb().query(`SELECT summary FROM tasks WHERE id = $1`, [id]);
    expect((rows[0].summary as string).length).toBeLessThanOrEqual(200);
    expect((rows[0].summary as string).endsWith('\u2026')).toBe(true);
  });

  it('distinguishes tasks across platforms', async () => {
    const slack = await upsertTask({ platform: 'slack', channelId: 'C1', threadTs: '1.0' });
    const telegram = await upsertTask({ platform: 'telegram', channelId: 'C1', threadTs: '1.0' });
    expect(slack).not.toBe(telegram);
  });
});

describe('beginActivity + finishActivity', () => {
  it('increments the task activity_count and bumps last_activity_at', async () => {
    const agentId = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C1', threadTs: '1.0' });

    const before = await getDb().query(`SELECT activity_count FROM tasks WHERE id = $1`, [taskId]);
    expect(Number(before.rows[0].activity_count)).toBe(0);

    const activityId = await beginActivity({
      taskId,
      agentId,
      platform: 'slack',
      initiatorKind: 'user',
      initiatorUserId: 'U1',
      messageRef: 'M1',
      messagePreview: 'hi',
    });
    expect(activityId).toMatch(/^[0-9a-f-]{36}$/i);

    const afterBegin = await getDb().query(`SELECT activity_count FROM tasks WHERE id = $1`, [taskId]);
    expect(Number(afterBegin.rows[0].activity_count)).toBe(1);

    const openRow = await getDb().query(`SELECT * FROM activities WHERE id = $1`, [activityId]);
    expect(openRow.rows[0].status).toBe('in_progress');
    expect(openRow.rows[0].finished_at).toBeNull();

    await finishActivity(activityId, 'done');
    const doneRow = await getDb().query(`SELECT * FROM activities WHERE id = $1`, [activityId]);
    expect(doneRow.rows[0].status).toBe('done');
    expect(doneRow.rows[0].finished_at).toBeTruthy();
  });

  it('finishing with error closes dangling in_progress tool_calls', async () => {
    const agentId = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C1', threadTs: '1.0' });
    const activityId = await beginActivity({
      taskId, agentId, platform: 'slack', initiatorKind: 'user',
    });
    const tcId = await beginToolCall({ activityId, toolName: 'mcp__redshift__query', argsPreview: '{"q":"select 1"}' });

    await finishActivity(activityId, 'error', 'boom');

    const tc = await getDb().query(`SELECT * FROM tool_calls WHERE id = $1`, [tcId]);
    expect(tc.rows[0].status).toBe('error');
    expect(tc.rows[0].finished_at).toBeTruthy();
  });
});

describe('tool_call lifecycle', () => {
  it('increments activity.tool_call_count and records status', async () => {
    const agentId = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C1', threadTs: '1.0' });
    const activityId = await beginActivity({
      taskId, agentId, platform: 'slack', initiatorKind: 'user',
    });

    const tc1 = await beginToolCall({ activityId, toolName: 'Read' });
    const tc2 = await beginToolCall({ activityId, toolName: 'Bash' });
    await finishToolCall(tc1, 'ok', 'file contents');
    await finishToolCall(tc2, 'error', 'exit 1');

    const count = await getDb().query(`SELECT tool_call_count FROM activities WHERE id = $1`, [activityId]);
    expect(Number(count.rows[0].tool_call_count)).toBe(2);

    const rows = await getDb().query(
      `SELECT tool_name, status FROM tool_calls WHERE activity_id = $1 ORDER BY started_at`,
      [activityId],
    );
    expect(rows.rows.map(r => [r.tool_name, r.status])).toEqual([
      ['Read', 'ok'],
      ['Bash', 'error'],
    ]);
  });
});

describe('listTasks', () => {
  it('buckets tasks into active / recent / errored by activity status', async () => {
    const agentId = await seedAgent();

    // Task A: active (one in_progress activity)
    const a = await upsertTask({ platform: 'slack', channelId: 'C1', threadTs: 'A' });
    await beginActivity({ taskId: a, agentId, platform: 'slack', initiatorKind: 'user' });

    // Task B: recent (one done activity, no error, no in_progress)
    const b = await upsertTask({ platform: 'slack', channelId: 'C1', threadTs: 'B' });
    const bAct = await beginActivity({ taskId: b, agentId, platform: 'slack', initiatorKind: 'user' });
    await finishActivity(bAct, 'done');

    // Task C: errored
    const c = await upsertTask({ platform: 'slack', channelId: 'C1', threadTs: 'C' });
    const cAct = await beginActivity({ taskId: c, agentId, platform: 'slack', initiatorKind: 'user' });
    await finishActivity(cAct, 'error', 'boom');

    const active = await listTasks('active');
    const recent = await listTasks('recent');
    const errored = await listTasks('errored');

    expect(active.tasks.map(t => t.id)).toEqual([a]);
    expect(recent.tasks.map(t => t.id)).toEqual([b]);
    expect(errored.tasks.map(t => t.id)).toEqual([c]);
  });

  it('paginates via cursor', async () => {
    const agentId = await seedAgent();
    for (let i = 0; i < 5; i++) {
      const id = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: `t${i}` });
      const act = await beginActivity({ taskId: id, agentId, platform: 'slack', initiatorKind: 'user' });
      await finishActivity(act, 'done');
    }

    const page1 = await listTasks('recent', {}, 2, null);
    expect(page1.tasks).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listTasks('recent', {}, 2, page1.nextCursor);
    expect(page2.tasks).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listTasks('recent', {}, 2, page2.nextCursor);
    expect(page3.tasks).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.tasks, ...page2.tasks, ...page3.tasks].map(t => t.id);
    // No duplicates and no missed rows across pages.
    expect(new Set(allIds).size).toBe(5);
  });

  it('filters by agentId', async () => {
    const a1 = await seedAgent();
    const a2 = await seedAgent();

    const t1 = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't1' });
    await beginActivity({ taskId: t1, agentId: a1, platform: 'slack', initiatorKind: 'user' });

    const t2 = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't2' });
    await beginActivity({ taskId: t2, agentId: a2, platform: 'slack', initiatorKind: 'user' });

    const forA1 = await listTasks('active', { agentId: a1 });
    expect(forA1.tasks.map(t => t.id)).toEqual([t1]);

    const forA2 = await listTasks('active', { agentId: a2 });
    expect(forA2.tasks.map(t => t.id)).toEqual([t2]);
  });
});

describe('getTaskWithDetails', () => {
  it('returns the task with activities and their tool_calls nested', async () => {
    const agentId = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't' });
    const act = await beginActivity({ taskId, agentId, platform: 'slack', initiatorKind: 'user' });
    const tc = await beginToolCall({ activityId: act, toolName: 'Bash' });
    await finishToolCall(tc, 'ok', 'hello');
    await finishActivity(act, 'done');

    const details = await getTaskWithDetails(taskId);
    expect(details?.task.id).toBe(taskId);
    expect(details?.activities).toHaveLength(1);
    expect(details?.activities[0].toolCalls).toHaveLength(1);
    expect(details?.activities[0].toolCalls[0].toolName).toBe('Bash');
  });

  it('returns null for unknown task id', async () => {
    const details = await getTaskWithDetails('does-not-exist');
    expect(details).toBeNull();
  });
});

describe('countInProgressByAgent', () => {
  it('sums in_progress activities per agent', async () => {
    const a1 = await seedAgent();
    const a2 = await seedAgent();
    const t = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't' });

    const open1 = await beginActivity({ taskId: t, agentId: a1, platform: 'slack', initiatorKind: 'user' });
    await beginActivity({ taskId: t, agentId: a1, platform: 'slack', initiatorKind: 'agent' });
    const open3 = await beginActivity({ taskId: t, agentId: a2, platform: 'slack', initiatorKind: 'agent' });

    const counts = await countInProgressByAgent();
    expect(counts[a1]).toBe(2);
    expect(counts[a2]).toBe(1);

    await finishActivity(open1, 'done');
    await finishActivity(open3, 'done');

    const after = await countInProgressByAgent();
    expect(after[a1]).toBe(1);
    expect(after[a2]).toBeUndefined();
  });
});

describe('cascade delete', () => {
  it('deleting a task cascades to activities and tool_calls', async () => {
    const agentId = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't' });
    const act = await beginActivity({ taskId, agentId, platform: 'slack', initiatorKind: 'user' });
    await beginToolCall({ activityId: act, toolName: 'Read' });

    await getDb().query(`DELETE FROM tasks WHERE id = $1`, [taskId]);

    const actRows = await getDb().query(`SELECT COUNT(*) AS n FROM activities WHERE task_id = $1`, [taskId]);
    expect(Number(actRows.rows[0].n)).toBe(0);
    const tcRows = await getDb().query(`SELECT COUNT(*) AS n FROM tool_calls WHERE activity_id = $1`, [act]);
    expect(Number(tcRows.rows[0].n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Usage aggregation
// ---------------------------------------------------------------------------

/** Seed a finished activity with explicit token usage for aggregation tests. */
async function seedActivityWithUsage(opts: {
  taskId: string;
  agentId: string;
  userId: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  /** Offset the started_at by this many seconds into the past. */
  ageSeconds?: number;
}): Promise<string> {
  const id = await beginActivity({
    taskId: opts.taskId,
    agentId: opts.agentId,
    platform: 'slack',
    initiatorKind: 'user',
    initiatorUserId: opts.userId,
  });
  await recordActivityUsage(id, {
    input_tokens: opts.input,
    output_tokens: opts.output,
    cache_read_input_tokens: opts.cacheRead ?? 0,
    cache_creation_input_tokens: opts.cacheCreation ?? 0,
  });
  if (opts.ageSeconds != null && opts.ageSeconds > 0) {
    const backdated = new Date(Date.now() - opts.ageSeconds * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    await getDb().query(
      `UPDATE activities SET started_at = $1 WHERE id = $2`,
      [backdated, id],
    );
  }
  await finishActivity(id, 'done');
  return id;
}

describe('recordActivityUsage', () => {
  it('writes the four token columns on the activity row', async () => {
    const agentId = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't' });
    const actId = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U1',
    });

    await recordActivityUsage(actId, {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 400,
    });

    const { rows } = await getDb().query(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
         FROM activities WHERE id = $1`, [actId],
    );
    expect(Number(rows[0].input_tokens)).toBe(100);
    expect(Number(rows[0].output_tokens)).toBe(200);
    expect(Number(rows[0].cache_read_tokens)).toBe(300);
    expect(Number(rows[0].cache_creation_tokens)).toBe(400);
  });

  it('coerces missing fields to 0', async () => {
    const agentId = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't' });
    const actId = await beginActivity({
      taskId, agentId, platform: 'slack', initiatorKind: 'user', initiatorUserId: 'U1',
    });

    await recordActivityUsage(actId, { input_tokens: 5 });

    const { rows } = await getDb().query(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
         FROM activities WHERE id = $1`, [actId],
    );
    expect(Number(rows[0].input_tokens)).toBe(5);
    expect(Number(rows[0].output_tokens)).toBe(0);
    expect(Number(rows[0].cache_read_tokens)).toBe(0);
    expect(Number(rows[0].cache_creation_tokens)).toBe(0);
  });
});

describe('getTokensByAgent', () => {
  it('sums per-agent tokens within the window and sorts descending', async () => {
    const aHigh = await seedAgent();
    const aLow  = await seedAgent();
    const task = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't1', initiatorUserId: 'U1' });

    await seedActivityWithUsage({ taskId: task, agentId: aHigh, userId: 'U1', input: 500,  output: 50 });
    await seedActivityWithUsage({ taskId: task, agentId: aHigh, userId: 'U1', input: 500,  output: 50 });
    await seedActivityWithUsage({ taskId: task, agentId: aLow,  userId: 'U1', input: 10,   output: 10 });

    const rows = await getTokensByAgent({});
    expect(rows).toHaveLength(2);
    expect(rows[0].agentId).toBe(aHigh);
    expect(rows[0].inputTokens).toBe(1000);
    expect(rows[0].outputTokens).toBe(100);
    expect(rows[0].turnCount).toBe(2);
    expect(rows[1].agentId).toBe(aLow);
  });

  it('filters activities older than `since`', async () => {
    const agentId = await seedAgent();
    const task = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't', initiatorUserId: 'U1' });

    await seedActivityWithUsage({ taskId: task, agentId, userId: 'U1', input: 100, output: 10, ageSeconds: 3600 });
    await seedActivityWithUsage({ taskId: task, agentId, userId: 'U1', input: 5,   output: 1 });

    const since = new Date(Date.now() - 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = await getTokensByAgent({ since });
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(5);
    expect(rows[0].turnCount).toBe(1);
  });

  it('respects accessibleAgentIds (empty array → empty result)', async () => {
    const agentId = await seedAgent();
    const task = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't', initiatorUserId: 'U1' });
    await seedActivityWithUsage({ taskId: task, agentId, userId: 'U1', input: 10, output: 10 });

    expect(await getTokensByAgent({ accessibleAgentIds: [] })).toHaveLength(0);
    expect(await getTokensByAgent({ accessibleAgentIds: [agentId] })).toHaveLength(1);
    expect(await getTokensByAgent({ accessibleAgentIds: [randomUUID()] })).toHaveLength(0);
  });

  it('treats NULL token columns (pre-feature rows) as zero', async () => {
    const agentId = await seedAgent();
    const task = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't', initiatorUserId: 'U1' });
    await beginActivity({ taskId: task, agentId, platform: 'slack', initiatorKind: 'user', initiatorUserId: 'U1' });

    const rows = await getTokensByAgent({});
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(0);
    expect(rows[0].outputTokens).toBe(0);
    expect(rows[0].turnCount).toBe(1);
  });
});

describe('getTopUsers', () => {
  it('ranks by distinct task count with turn-count tiebreaker', async () => {
    const agentId = await seedAgent();
    const big   = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 'big',   initiatorUserId: 'U_big',  initiatorHandle: 'alice' });
    const busy1 = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 'busy1', initiatorUserId: 'U_busy', initiatorHandle: 'bob' });
    const busy2 = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 'busy2', initiatorUserId: 'U_busy', initiatorHandle: 'bob' });

    for (let i = 0; i < 5; i++) {
      await seedActivityWithUsage({ taskId: big, agentId, userId: 'U_big', input: 1, output: 1 });
    }
    await seedActivityWithUsage({ taskId: busy1, agentId, userId: 'U_busy', input: 1, output: 1 });
    await seedActivityWithUsage({ taskId: busy2, agentId, userId: 'U_busy', input: 1, output: 1 });

    const rows = await getTopUsers({});
    expect(rows[0].userId).toBe('U_busy');
    expect(rows[0].taskCount).toBe(2);
    expect(rows[0].handle).toBe('bob');
    expect(rows[1].userId).toBe('U_big');
    expect(rows[1].taskCount).toBe(1);
    expect(rows[1].turnCount).toBe(5);
  });

  it('user totals reconcile with getTokensByAgent for the same window (regression guard)', async () => {
    // Earlier version filtered on tasks.last_activity_at, which over-counted
    // turns on long-lived tasks. Now both aggregates filter on a.started_at
    // so a user's totalTokens equals the sum of per-agent tokens they drove.
    const agentId = await seedAgent();
    const task = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't', initiatorUserId: 'U', initiatorHandle: 'amy' });

    await seedActivityWithUsage({ taskId: task, agentId, userId: 'U', input: 100, output: 10, ageSeconds: 7200 });
    await seedActivityWithUsage({ taskId: task, agentId, userId: 'U', input: 50,  output: 5 });

    const since = new Date(Date.now() - 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const byAgent = await getTokensByAgent({ since });
    const byUser  = await getTopUsers({ since });

    expect(byAgent[0].inputTokens).toBe(50);
    expect(byAgent[0].outputTokens).toBe(5);
    expect(byAgent[0].turnCount).toBe(1);
    expect(byUser[0].totalTokens).toBe(55);
    expect(byUser[0].turnCount).toBe(1);
    expect(byUser[0].taskCount).toBe(1);
  });

  it('excludes tasks with no initiator_user_id', async () => {
    const agentId = await seedAgent();
    const anon = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 'anon' });
    await seedActivityWithUsage({ taskId: anon, agentId, userId: 'U_ignored', input: 100, output: 10 });

    expect(await getTopUsers({})).toHaveLength(0);
  });

  it('respects the limit arg', async () => {
    const agentId = await seedAgent();
    for (let i = 0; i < 5; i++) {
      const t = await upsertTask({
        platform: 'slack', channelId: 'C', threadTs: `t${i}`,
        initiatorUserId: `U${i}`, initiatorHandle: `u${i}`,
      });
      await seedActivityWithUsage({ taskId: t, agentId, userId: `U${i}`, input: 1, output: 1 });
    }
    expect(await getTopUsers({}, 3)).toHaveLength(3);
  });
});
