/**
 * @fileoverview Tests for AgentRunner.replayActivity + autoReplaySweptActivities.
 *
 * Replay reconstructs an IncomingMessage from a stored activity row and
 * hands it to the live MessageHandler. Auto-replay walks the activities
 * just marked stale by sweepStaleActivities and calls replay for each one
 * that passes safety filters (age, already-handled, crash-loop cap).
 *
 * The runner is constructed with no Slack adapter — we inject a minimal
 * fake into runningAgents so the replay path has a MessageHandler to call.
 *
 * @module runner/__tests__/replay-activity.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSqliteAdapter,
  setDb,
  getDb,
  closeDb,
  upsertTask,
  beginActivity,
  finishActivity,
} from '@slackhive/shared';
import { AgentRunner } from '../agent-runner';

let dbPath: string;
let runner: AgentRunner;

async function seedAgent(id = 'agent-replay-1'): Promise<string> {
  await getDb().query(
    `INSERT INTO agents (id, slug, name, persona, description, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, `slug-${id.slice(0, 8)}`, 'Replay Agent', null, null, 'claude-opus-4-7'],
  );
  return id;
}

function injectFakeRunning(
  agentId: string,
  handleMessage: (msg: any) => Promise<void> = async () => {},
): { handleSpy: ReturnType<typeof vi.fn> } {
  const handleSpy = vi.fn(handleMessage);
  const fake = {
    agent: { id: agentId, slug: `slug-${agentId.slice(0, 8)}` } as any,
    adapter: {} as any,
    claudeHandler: {} as any,
    messageHandler: { handleMessage: handleSpy } as any,
    memoryWatcher: {} as any,
  };
  // Reach into the private map — keeping the test surface tiny instead of
  // exposing a setter just for tests.
  (runner as any).runningAgents.set(agentId, fake);
  return { handleSpy };
}

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-activity-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
  runner = new AgentRunner();
});

afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('AgentRunner.replayActivity', () => {
  it('reconstructs the IncomingMessage and dispatches to the agent\'s MessageHandler', async () => {
    const agentId = await seedAgent();
    const { handleSpy } = injectFakeRunning(agentId);

    const taskId = await upsertTask({
      platform: 'slack',
      channelId: 'C123',
      threadTs: '1700.0',
      initiatorUserId: 'U_alice',
      initiatorHandle: 'alice',
    });
    const activityId = await beginActivity({
      taskId,
      agentId,
      platform: 'slack',
      initiatorKind: 'user',
      initiatorUserId: 'U_alice',
      messageRef: '1700.0',
      messagePreview: 'redo this question',
    });
    await finishActivity(activityId, 'error', 'Interrupted — runner restarted');

    const result = await runner.replayActivity(activityId);
    expect(result).toEqual({ ok: true });
    expect(handleSpy).toHaveBeenCalledTimes(1);
    const msg = handleSpy.mock.calls[0][0];
    expect(msg).toMatchObject({
      platform: 'slack',
      userId: 'U_alice',
      channelId: 'C123',
      threadId: '1700.0',
      text: 'redo this question',
      isDM: false,
      raw: { replay: true, originalActivityId: activityId },
    });
  });

  it('detects DMs by Slack channel-ID prefix', async () => {
    const agentId = await seedAgent();
    const { handleSpy } = injectFakeRunning(agentId);

    const taskId = await upsertTask({
      platform: 'slack',
      channelId: 'D9999',
      threadTs: 'dm-thread',
      initiatorUserId: 'U_dm',
    });
    const aId = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U_dm',
      messageRef: 'dm-thread', messagePreview: 'private question',
    });

    await runner.replayActivity(aId);
    expect(handleSpy.mock.calls[0][0].isDM).toBe(true);
  });

  it('returns not-ok when the activity is missing', async () => {
    const result = await runner.replayActivity('11111111-1111-1111-1111-111111111111');
    expect(result).toEqual({ ok: false, error: 'activity not found' });
  });

  it('returns not-ok when the agent is not currently running', async () => {
    const agentId = await seedAgent('orphan-agent');
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't', initiatorUserId: 'U' });
    const aId = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U',
      messageRef: 'm', messagePreview: 'x',
    });
    // Note: no injectFakeRunning() — the agent is not in runningAgents.
    const result = await runner.replayActivity(aId);
    expect(result).toEqual({ ok: false, error: 'agent not running' });
  });

  it('returns not-ok when the activity row is missing channel/user/text', async () => {
    const agentId = await seedAgent();
    injectFakeRunning(agentId);
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C', threadTs: 't', initiatorUserId: 'U' });
    const aId = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U',
      messagePreview: 'x',
    });
    // Wipe the initiator so the row genuinely lacks a replayable user — the
    // schema lets that happen for agent-initiated rows in production.
    await getDb().query(`UPDATE activities SET initiator_user_id = NULL WHERE id = $1`, [aId]);

    const result = await runner.replayActivity(aId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing replay fields/);
  });

  it('returns not-ok with empty activityId', async () => {
    const result = await runner.replayActivity('');
    expect(result).toEqual({ ok: false, error: 'activityId required' });
  });
});

describe('AgentRunner.autoReplaySweptActivities', () => {
  it('replays in-window activities and tags the original with [auto-replayed]', async () => {
    const agentId = await seedAgent();
    const { handleSpy } = injectFakeRunning(agentId);

    const taskId = await upsertTask({
      platform: 'slack', channelId: 'C', threadTs: 't1',
      initiatorUserId: 'U_a', initiatorHandle: 'alice',
    });
    const aId = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U_a',
      messageRef: 'm1', messagePreview: 'recover me',
    });
    await finishActivity(aId, 'error', 'Interrupted — runner restarted');

    await (runner as any).autoReplaySweptActivities([aId]);

    expect(handleSpy).toHaveBeenCalledTimes(1);
    const after = await getDb().query(`SELECT error FROM activities WHERE id = $1`, [aId]);
    expect(after.rows[0].error as string).toContain('[auto-replayed]');
  });

  it('skips activities older than the 30-min cutoff', async () => {
    const agentId = await seedAgent();
    const { handleSpy } = injectFakeRunning(agentId);
    const taskId = await upsertTask({
      platform: 'slack', channelId: 'C', threadTs: 'old',
      initiatorUserId: 'U', initiatorHandle: 'u',
    });
    const aId = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U',
      messageRef: 'old-m', messagePreview: 'stale',
    });
    // Backdate started_at to 2h ago.
    await getDb().query(
      `UPDATE activities SET started_at = datetime('now', '-2 hours') WHERE id = $1`,
      [aId],
    );

    await (runner as any).autoReplaySweptActivities([aId]);
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('skips when a newer activity already exists in the same task (user already engaged)', async () => {
    const agentId = await seedAgent();
    const { handleSpy } = injectFakeRunning(agentId);
    const taskId = await upsertTask({
      platform: 'slack', channelId: 'C', threadTs: 'engaged',
      initiatorUserId: 'U', initiatorHandle: 'u',
    });
    // Original interrupted.
    const interrupted = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U',
      messageRef: 'm-old', messagePreview: 'first',
    });
    await finishActivity(interrupted, 'error', 'Interrupted — runner restarted');
    // User then sent a follow-up that landed cleanly.
    const followup = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U',
      messageRef: 'm-new', messagePreview: 'follow-up',
    });
    await finishActivity(followup, 'done');

    await (runner as any).autoReplaySweptActivities([interrupted]);
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('skips when 3+ auto-replays have already happened for this task in the last hour', async () => {
    const agentId = await seedAgent();
    const { handleSpy } = injectFakeRunning(agentId);
    const taskId = await upsertTask({
      platform: 'slack', channelId: 'C', threadTs: 'crashloop',
      initiatorUserId: 'U', initiatorHandle: 'u',
    });

    // 3 prior activities already auto-replayed in this task.
    for (let i = 0; i < 3; i++) {
      const id = await beginActivity({
        taskId, agentId, platform: 'slack',
        initiatorKind: 'user', initiatorUserId: 'U',
        messageRef: `prior-${i}`, messagePreview: `prior ${i}`,
      });
      await finishActivity(id, 'error', 'Interrupted — runner restarted [auto-replayed]');
    }
    // The fresh one we'd otherwise replay.
    const fresh = await beginActivity({
      taskId, agentId, platform: 'slack',
      initiatorKind: 'user', initiatorUserId: 'U',
      messageRef: 'm-fresh', messagePreview: 'fresh',
    });
    await finishActivity(fresh, 'error', 'Interrupted — runner restarted');

    await (runner as any).autoReplaySweptActivities([fresh]);
    expect(handleSpy).not.toHaveBeenCalled();
  });
});
