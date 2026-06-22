/**
 * @fileoverview getToolStats error-group aggregation: the drill-down must point at
 * the MOST RECENT session for an error (not a lexicographic MAX), and report how
 * many DISTINCT sessions an error spans.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter, setDb, getDb, closeDb, getToolStats } from '@slackhive/shared';

let dbPath: string;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-stats-'));
  dbPath = path.join(dir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});
afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

async function errSpan(id: string, session: string, tool: string, msg: string, startMs: number): Promise<void> {
  await getDb().query(
    `INSERT INTO spans (span_id, trace_id, session_id, agent_id, kind, name, tool_name, start_ms, end_ms, status, status_message)
     VALUES ($1,'tr',$2,'ag','tool',$3,$3,$4,$5,'error',$6)`,
    [id, session, tool, startMs, startMs + 1, msg],
  );
}

describe('getToolStats — error drill-down', () => {
  it('points at the most-recent session and counts distinct sessions for an error', async () => {
    // Same error message across 3 sessions at increasing times; one session_id sorts
    // LOW lexically but is the latest in time — the link must follow time, not text.
    await errSpan('s1', 'zzz-old',   'mcp__db__query', 'timeout', 1000);
    await errSpan('s2', 'aaa-newer', 'mcp__db__query', 'timeout', 3000); // latest
    await errSpan('s3', 'mmm-mid',   'mcp__db__query', 'timeout', 2000);
    // A different error on the same tool, single session.
    await errSpan('s4', 'aaa-newer', 'mcp__db__query', 'permission denied', 2500);

    const tools = await getToolStats();
    const tool = tools.find(t => t.name === 'mcp__db__query');
    expect(tool?.errors).toBe(4);

    const timeout = tool!.errorGroups.find(g => g.message === 'timeout');
    expect(timeout?.count).toBe(3);
    expect(timeout?.sessions).toBe(3);                 // 3 distinct sessions
    expect(timeout?.sampleSessionId).toBe('aaa-newer'); // the LATEST by start_ms, not MAX(session_id)='zzz-old'

    const denied = tool!.errorGroups.find(g => g.message === 'permission denied');
    expect(denied?.count).toBe(1);
    expect(denied?.sessions).toBe(1);
  });
});
