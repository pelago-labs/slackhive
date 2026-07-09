/**
 * @fileoverview Tests for getInsightsRollup — the scope-aware aggregate behind the
 * LLMOps page. Verifies: one-agent scope matches getAgentRollup; all-agents pools
 * across agents; RBAC restriction and the empty-allowlist short-circuit.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter, setDb, getDb, closeDb, getInsightsRollup, getAgentRollup } from '@slackhive/shared';

let dbPath: string;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-'));
  dbPath = path.join(dir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});
afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

async function agent(id: string) {
  await getDb().query(`INSERT INTO agents (id, slug, name, model) VALUES ($1,$1,$1,'m')`, [id]);
}
async function task(id: string) {
  await getDb().query(`INSERT INTO tasks (id, platform, channel_id, thread_ts) VALUES ($1,'slack','C',$1)`, [id]);
}
async function activity(id: string, taskId: string, agentId: string, inTok: number, outTok: number, status = 'done') {
  await getDb().query(
    `INSERT INTO activities (id, task_id, agent_id, initiator_kind, status, started_at, input_tokens, output_tokens)
     VALUES ($1,$2,$3,'user',$4,'2026-01-01 00:00:01',$5,$6)`,
    [id, taskId, agentId, status, inTok, outTok],
  );
}

describe('getInsightsRollup — scope', () => {
  beforeEach(async () => {
    await agent('ag1'); await agent('ag2');
    await task('t1'); await task('t2'); await task('t3');
    await activity('a1', 't1', 'ag1', 100, 10);
    await activity('a2', 't2', 'ag1', 200, 20);
    await activity('a3', 't3', 'ag2', 5, 1, 'error');
  });

  it('one-agent scope matches getAgentRollup for the same agent', async () => {
    const insights = await getInsightsRollup({ agentId: 'ag1' });
    const rollup = await getAgentRollup({ agentId: 'ag1' });
    expect(insights.sessions).toBe(rollup.sessions);
    expect(insights.turns).toBe(rollup.turns);
    expect(insights.inputTokens).toBe(rollup.inputTokens);
    expect(insights.totalTokens).toBe(rollup.totalTokens);
    expect(insights.inputTokens).toBe(300); // 100 + 200
  });

  it('all-agents scope (no restriction) pools across every agent', async () => {
    const all = await getInsightsRollup({});
    expect(all.turns).toBe(3);
    expect(all.sessions).toBe(3);
    expect(all.inputTokens).toBe(305);   // 100 + 200 + 5
    expect(all.errorTurns).toBe(1);
    // Window-wide session-status breakdown (Sessions tab summary cards) — counts
    // whole sessions, not turns, across the entire window (not just a loaded page).
    expect(all.sessionsError).toBe(1);       // t3 is an errored session
    expect(all.sessionsActive).toBe(0);      // none in progress
    expect(all.sessionsSensitive).toBe(0);   // no sensitive spans seeded
    // Done is derived in the UI: sessions − active − error = 3 − 0 − 1 = 2.
    expect(all.sessions - (all.sessionsActive ?? 0) - (all.sessionsError ?? 0)).toBe(2);
  });

  it('restricts to the accessible-agent set', async () => {
    const r = await getInsightsRollup({ accessibleAgentIds: ['ag1'] });
    expect(r.turns).toBe(2);             // only ag1's activities
    expect(r.inputTokens).toBe(300);
  });

  it('empty accessible set returns an empty rollup, never all-agents', async () => {
    const r = await getInsightsRollup({ accessibleAgentIds: [] });
    expect(r.turns).toBe(0);
    expect(r.sessions).toBe(0);
    expect(r.inputTokens).toBe(0);
  });

  it('one-agent scope outside the accessible set yields empty (defense in depth)', async () => {
    const r = await getInsightsRollup({ agentId: 'ag2', accessibleAgentIds: ['ag1'] });
    expect(r.turns).toBe(0);
  });
});
