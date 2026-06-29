/**
 * @fileoverview Regression tests for code-review fixes in trace-repo:
 *  - getSessionTrace scopes turns/spans to the caller's accessible agents (#1),
 *  - pruneTraceData reaps recent spans of a pruned task (#4),
 *  - getAgentRollup per-model `turns` counts distinct turns, not spans (#5),
 *  - getSessionTrace turn ordering tiebreaks on insert order (#7).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter, setDb, getDb, closeDb, getSessionTrace, getAgentRollup, pruneTraceData } from '@slackhive/shared';

let dbPath: string;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-review-'));
  dbPath = path.join(dir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});
afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

async function task(id: string, lastActivityAt?: string) {
  await getDb().query(
    `INSERT INTO tasks (id, platform, channel_id, thread_ts, last_activity_at) VALUES ($1,'slack','C',$1,COALESCE($2, datetime('now')))`,
    [id, lastActivityAt ?? null],
  );
}
async function agent(id: string) {
  await getDb().query(`INSERT INTO agents (id, slug, name, model) VALUES ($1,$1,$1,'m')`, [id]);
}
async function activity(id: string, taskId: string, agentId: string, startedAt: string, model?: string) {
  await getDb().query(
    `INSERT INTO activities (id, task_id, agent_id, initiator_kind, status, started_at, model) VALUES ($1,$2,$3,'user','done',$4,$5)`,
    [id, taskId, agentId, startedAt, model ?? null],
  );
}
async function span(id: string, session: string, activityId: string, agentId: string, opts: { model?: string; startMs?: number } = {}) {
  await getDb().query(
    `INSERT INTO spans (span_id, trace_id, session_id, activity_id, agent_id, kind, name, model, start_ms, end_ms, sensitive)
     VALUES ($1,'tr',$2,$3,$4,'generation','chat',$5,$6,$7,0)`,
    [id, session, activityId, agentId, opts.model ?? null, opts.startMs ?? 1000, (opts.startMs ?? 1000) + 1],
  );
}

describe('getSessionTrace — agent-scope filter (#1)', () => {
  beforeEach(async () => {
    await agent('ag1'); await agent('ag2');
    await task('sess');
    await activity('a1', 'sess', 'ag1', '2026-01-01 00:00:01');
    await activity('a2', 'sess', 'ag2', '2026-01-01 00:00:02');
    await span('s1', 'sess', 'a1', 'ag1');
    await span('s2', 'sess', 'a2', 'ag2');
  });
  it('returns all turns for an unrestricted (admin) caller', async () => {
    const trace = await getSessionTrace('sess', null);
    expect(trace?.turns.map(t => t.agentId).sort()).toEqual(['ag1', 'ag2']);
  });
  it('returns only the accessible agent’s turns/spans for a restricted caller', async () => {
    const trace = await getSessionTrace('sess', ['ag1']);
    expect(trace?.turns.map(t => t.agentId)).toEqual(['ag1']);
    expect(trace?.turns.flatMap(t => t.spans.map(s => s.spanId))).toEqual(['s1']); // ag2's span excluded
  });
  it('returns nothing when the accessible set is empty', async () => {
    const trace = await getSessionTrace('sess', []);
    expect(trace?.turns).toEqual([]);
  });
});

describe('getSessionTrace — deterministic same-second ordering (#7)', () => {
  it('orders same-started_at turns by insert order, not random UUID', async () => {
    await agent('ag'); await task('sess2');
    // Both activities share the exact started_at; insert b before a alphabetically by id.
    await activity('zzz-first', 'sess2', 'ag', '2026-01-01 00:00:05');
    await activity('aaa-second', 'sess2', 'ag', '2026-01-01 00:00:05');
    const trace = await getSessionTrace('sess2', null);
    expect(trace?.turns.map(t => t.activityId)).toEqual(['zzz-first', 'aaa-second']); // rowid (insert) order
  });
});

describe('getAgentRollup — per-model turns counts distinct turns (#5)', () => {
  it('does not inflate model turns by the number of generation spans', async () => {
    await agent('agM'); await task('sessM');
    // By-model derives from `activities` (grouped on the per-turn model stamp), so
    // one turn is one row regardless of how many generation spans it produced.
    await activity('act1', 'sessM', 'agM', '2026-01-01 00:00:01', 'm1');
    await span('g1', 'sessM', 'act1', 'agM', { model: 'm1' });
    await span('g2', 'sessM', 'act1', 'agM', { model: 'm1' });
    await span('g3', 'sessM', 'act1', 'agM', { model: 'm1' });
    const rollup = await getAgentRollup({ agentId: 'agM' });
    const m1 = rollup.models.find(m => m.model === 'm1');
    expect(m1?.turns).toBe(1); // distinct activities, not 3 spans
  });
});

describe('pruneTraceData — reaps recent spans of a pruned task (#4)', () => {
  it('deletes orphaned spans of a deleted task regardless of their start_ms', async () => {
    await task('old', '2020-01-01 00:00:00');   // far past retention → pruned
    await task('keep');                          // recent → retained
    await span('s-old', 'old', 'a', 'ag', { startMs: Date.now() });  // RECENT span under the OLD task
    await span('s-keep', 'keep', 'a', 'ag', { startMs: Date.now() });
    await pruneTraceData(1); // 1-day retention

    const oldRows = await getDb().query(`SELECT 1 FROM spans WHERE span_id='s-old'`);
    const keepRows = await getDb().query(`SELECT 1 FROM spans WHERE span_id='s-keep'`);
    expect(oldRows.rows).toHaveLength(0); // recent span of pruned task is gone (no leak past retention)
    expect(keepRows.rows).toHaveLength(1); // span of retained task survives
  });
});
