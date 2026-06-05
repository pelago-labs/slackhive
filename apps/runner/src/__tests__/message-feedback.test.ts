/**
 * @fileoverview Unit tests for message feedback (recordMessageFeedback +
 * getFeedbackReport) against the real SQLite adapter (temp DB per test).
 *
 * @module runner/__tests__/message-feedback.test
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
  recordMessageFeedback,
  getFeedbackReport,
} from '@slackhive/shared';

let dbPath: string;

async function seedAgent(id = randomUUID()): Promise<string> {
  const db = getDb();
  await db.query(
    `INSERT INTO agents (id, slug, name, persona, description, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, `slug-${id.slice(0, 8)}`, 'Test Agent', null, null, 'gpt-5.5'],
  );
  return id;
}

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-feedback-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});

afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('getFeedbackReport', () => {
  it('returns zeros for an agent with no feedback', async () => {
    const agentId = await seedAgent();
    const r = await getFeedbackReport(agentId);
    expect(r).toEqual({ up: 0, down: 0, total: 0, scorePercent: 0, recentNotes: [] });
  });

  it('scores 3 up / 1 down as 75%', async () => {
    const agentId = await seedAgent();
    for (let i = 0; i < 3; i++) {
      await recordMessageFeedback({ agentId, messageTs: `m${i}`, raterUserId: `u${i}`, sentiment: 'up' });
    }
    await recordMessageFeedback({ agentId, messageTs: 'm3', raterUserId: 'u3', sentiment: 'down', note: 'too slow' });

    const r = await getFeedbackReport(agentId);
    expect(r.up).toBe(3);
    expect(r.down).toBe(1);
    expect(r.total).toBe(4);
    expect(r.scorePercent).toBe(75);
    expect(r.recentNotes.map(n => n.note)).toEqual(['too slow']);
  });

  it('re-rating the same (message, rater) updates instead of duplicating, and merges the note', async () => {
    const agentId = await seedAgent();
    // 👎 on click (no note), then the modal adds the note — same message+rater.
    await recordMessageFeedback({ agentId, messageTs: 'mX', raterUserId: 'uX', sentiment: 'down' });
    await recordMessageFeedback({ agentId, messageTs: 'mX', raterUserId: 'uX', sentiment: 'down', note: 'wrong number' });

    const r = await getFeedbackReport(agentId);
    expect(r.total).toBe(1);
    expect(r.down).toBe(1);
    expect(r.recentNotes).toEqual([expect.objectContaining({ note: 'wrong number' })]);
  });

  it('does not leak feedback across agents', async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    await recordMessageFeedback({ agentId: a, messageTs: 'm1', raterUserId: 'u1', sentiment: 'up' });
    expect((await getFeedbackReport(b)).total).toBe(0);
    expect((await getFeedbackReport(a)).total).toBe(1);
  });
});
