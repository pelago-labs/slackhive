/**
 * @fileoverview Tests for sensitive-data flow lineage: privacy-safe fingerprints
 * (computeFps) and source→sink correlation (getSensitiveFlows) over the spans table.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter, setDb, getDb, closeDb, getSensitiveFlows, getSessionTrace } from '@slackhive/shared';
import { computeFps, fingerprint } from '../tracing/fingerprint';

let dbPath: string;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sens-flow-'));
  dbPath = path.join(dir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});
afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('computeFps / fingerprint', () => {
  it('is deterministic per value and stamps the role', () => {
    const a = computeFps('contact bob@acme.com', 'text', 'source');
    const b = computeFps('reply: bob@acme.com', 'text', 'sink');
    expect(a[0].fp).toBe(b[0].fp);          // same value → same fingerprint
    expect(a[0].tag).toBe('pii:email');
    expect(a[0].role).toBe('source');
    expect(b[0].role).toBe('sink');
  });
  it('does not leak the raw value', () => {
    const fp = fingerprint('AKIAIOSFODNN7EXAMPLE');
    expect(fp).not.toContain('AKIA');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
  it('returns nothing for clean content', () => {
    expect(computeFps('just a normal sentence', 'text', 'source')).toEqual([]);
  });
});

async function insertSpan(row: {
  id: string; session: string; kind: string; name: string; start: number; tool?: string; fps?: unknown[];
}): Promise<void> {
  await getDb().query(
    `INSERT INTO spans (span_id, trace_id, session_id, kind, name, tool_name, start_ms, end_ms, sensitive, sensitive_fps)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.id, 'tr', row.session, row.kind, row.name, row.tool ?? null, row.start, row.start + 1, 1, row.fps ? JSON.stringify(row.fps) : null],
  );
}

describe('getSensitiveFlows — source→sink correlation', () => {
  it('flags a secret read from a tool then sent via an egress tool (TT3 critical)', async () => {
    const fp = fingerprint('AKIAIOSFODNN7EXAMPLE');
    await getDb().query(`INSERT INTO tasks (id, platform, channel_id, thread_ts) VALUES ($1,'slack','C','t')`, ['sess1']);
    await insertSpan({ id: 'src', session: 'sess1', kind: 'tool', name: 'read', tool: 'redshift_query', start: 1000, fps: [{ fp, tag: 'secret:aws_key', role: 'source' }] });
    await insertSpan({ id: 'snk', session: 'sess1', kind: 'tool', name: 'send', tool: 'WebFetch', start: 2000, fps: [{ fp, tag: 'secret:aws_key', role: 'sink' }] });

    const flows = await getSensitiveFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({
      severity: 'critical', category: 'secret', sourceSpanId: 'src', sinkSpanId: 'snk',
      sourceLabel: 'redshift_query', sinkLabel: 'WebFetch', sessionId: 'sess1',
    });
  });

  it('does NOT create a flow when source and sink are the same span, or sink precedes source', async () => {
    const fp = fingerprint('bob@acme.com');
    await getDb().query(`INSERT INTO tasks (id, platform, channel_id, thread_ts) VALUES ($1,'slack','C','t')`, ['sess2']);
    // sink earlier than source → no flow
    await insertSpan({ id: 'sink-early', session: 'sess2', kind: 'generation', name: 'chat', start: 1000, fps: [{ fp, tag: 'pii:email', role: 'sink' }] });
    await insertSpan({ id: 'src-late', session: 'sess2', kind: 'tool', name: 'read', tool: 't', start: 2000, fps: [{ fp, tag: 'pii:email', role: 'source' }] });
    expect(await getSensitiveFlows()).toHaveLength(0);
  });

  it('surfaces flows in the single-session trace too', async () => {
    const fp = fingerprint('bob@acme.com');
    await getDb().query(`INSERT INTO tasks (id, platform, channel_id, thread_ts) VALUES ($1,'slack','C','t')`, ['sess3']);
    await getDb().query(`INSERT INTO agents (id, slug, name, model) VALUES ('ag','ag','Ag','m')`);
    await getDb().query(`INSERT INTO activities (id, task_id, agent_id, initiator_kind) VALUES ('a1','sess3','ag','user')`);
    await insertSpan({ id: 's1', session: 'sess3', kind: 'tool', name: 'read', tool: 'db', start: 1000, fps: [{ fp, tag: 'pii:email', role: 'source' }] });
    await insertSpan({ id: 's2', session: 'sess3', kind: 'generation', name: 'chat', start: 2000, fps: [{ fp, tag: 'pii:email', role: 'sink' }] });
    const trace = await getSessionTrace('sess3');
    expect(trace?.flows).toHaveLength(1);
    expect(trace?.flows[0].severity).toBe('high'); // pii flow
    expect(trace?.flows[0].sinkLabel).toBe('Agent reply');
  });
});
