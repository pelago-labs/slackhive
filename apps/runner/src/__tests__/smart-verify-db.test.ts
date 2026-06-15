/**
 * @fileoverview DB-backed tests for the Smart (LLM) verify/detect passes:
 *  - a downgraded false positive also clears its flow fingerprints (no stale flow),
 *  - running verify THEN detect leaves detect's real finding intact (ordering).
 * generateText is mocked so no model call is made.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteAdapter, setDb, getDb, closeDb, getSensitiveFlows } from '@slackhive/shared';
import { fingerprint } from '../tracing/fingerprint';

vi.mock('../backends/generate-text', () => ({ generateText: vi.fn() }));
import { generateText } from '../backends/generate-text';
import { verifySmartFindings, detectSmartFindings } from '../tracing/smart-verify';

const mockReply = (s: string) => vi.mocked(generateText).mockResolvedValueOnce(s);

let dbPath: string;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-db-'));
  dbPath = path.join(dir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
  vi.mocked(generateText).mockReset();
});
afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

async function insertSpan(id: string, session: string, opts: { fps?: unknown[]; severity?: string } = {}): Promise<void> {
  await getDb().query(
    `INSERT INTO spans (span_id, trace_id, session_id, kind, name, start_ms, end_ms, sensitive, sensitive_severity, sensitive_fps)
     VALUES ($1,'tr',$2,'tool','t',1000,1001,1,$3,$4)`,
    [id, session, opts.severity ?? null, opts.fps ? JSON.stringify(opts.fps) : null],
  );
}

describe('verifySmartFindings — downgrade clears flow fingerprints', () => {
  it('removes the exfiltration flow when the source is judged a false positive', async () => {
    const fp = fingerprint('AKIAIOSFODNN7EXAMPLE');
    await getDb().query(`INSERT INTO tasks (id, platform, channel_id, thread_ts) VALUES ('s','slack','C','t')`);
    await insertSpan('src', 's', { fps: [{ fp, tag: 'secret:aws_key', role: 'source' }], severity: 'critical' });
    await insertSpan('snk', 's', { fps: [{ fp, tag: 'secret:aws_key', role: 'sink' }], severity: 'critical' });
    expect(await getSensitiveFlows()).toHaveLength(1);

    mockReply('1: no'); // verifier rules the source span a false positive
    await verifySmartFindings([{ spanId: 'src', reason: 'secret:aws_key', sample: 'AK…(20)' }]);

    const { rows } = await getDb().query(`SELECT sensitive, sensitive_fps FROM spans WHERE span_id='src'`);
    expect(Number(rows[0].sensitive)).toBe(0);
    expect(rows[0].sensitive_fps).toBeNull();
    expect(await getSensitiveFlows()).toHaveLength(0); // flow no longer surfaces
  });
});

describe('verify then detect — detect wins on a shared span', () => {
  it('keeps the LLM finding (sensitive=1) even though verify downgraded the regex hit', async () => {
    await getDb().query(`INSERT INTO tasks (id, platform, channel_id, thread_ts) VALUES ('s2','slack','C','t')`);
    await insertSpan('sp', 's2', { severity: 'medium' });

    mockReply('1: no');                                  // verify: regex hit is a false positive → sensitive=0
    mockReply('1 | pii:phone | medium | five five five'); // detect: finds obfuscated PII → sensitive=1
    await verifySmartFindings([{ spanId: 'sp', reason: 'pii:phone', sample: 'x' }]);
    await detectSmartFindings([{ spanId: 'sp', kind: 'generation', content: 'call me at five five five' }]);

    const { rows } = await getDb().query(`SELECT sensitive, sensitive_llm FROM spans WHERE span_id='sp'`);
    expect(Number(rows[0].sensitive)).toBe(1);
    expect(Number(rows[0].sensitive_llm)).toBe(1);
  });
});
