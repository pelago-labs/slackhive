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
  getFeedbackFeed,
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
    expect(r).toEqual({ up: 0, down: 0, total: 0, scorePercent: 0, ratingCount: 0, recentRatings: [] });
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
    // All 4 ratings appear (newest first); only the 👎 carries a note.
    expect(r.ratingCount).toBe(4);
    expect(r.recentRatings.map(rt => rt.sentiment).sort()).toEqual(['down', 'up', 'up', 'up']);
    expect(r.recentRatings.find(rt => rt.sentiment === 'down')?.note).toBe('too slow');
  });

  it('filters the ratings list by sentiment without changing the score', async () => {
    const agentId = await seedAgent();
    for (let i = 0; i < 3; i++) {
      await recordMessageFeedback({ agentId, messageTs: `m${i}`, raterUserId: `u${i}`, sentiment: 'up' });
    }
    await recordMessageFeedback({ agentId, messageTs: 'm3', raterUserId: 'u3', sentiment: 'down', note: 'too slow' });

    const downOnly = await getFeedbackReport(agentId, { sentiment: 'down' });
    expect(downOnly.scorePercent).toBe(75); // summary unaffected by the filter
    expect(downOnly.ratingCount).toBe(1);
    expect(downOnly.recentRatings.every(rt => rt.sentiment === 'down')).toBe(true);
  });

  it('re-rating the same (message, rater) updates instead of duplicating, and merges the note', async () => {
    const agentId = await seedAgent();
    // 👎 on click (no note), then the modal adds the note — same message+rater.
    await recordMessageFeedback({ agentId, messageTs: 'mX', raterUserId: 'uX', sentiment: 'down' });
    await recordMessageFeedback({ agentId, messageTs: 'mX', raterUserId: 'uX', sentiment: 'down', note: 'wrong number' });

    const r = await getFeedbackReport(agentId);
    expect(r.total).toBe(1);
    expect(r.down).toBe(1);
    expect(r.recentRatings).toEqual([expect.objectContaining({ note: 'wrong number' })]);
  });

  it('does not leak feedback across agents', async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    await recordMessageFeedback({ agentId: a, messageTs: 'm1', raterUserId: 'u1', sentiment: 'up' });
    expect((await getFeedbackReport(b)).total).toBe(0);
    expect((await getFeedbackReport(a)).total).toBe(1);
  });
});

describe('getFeedbackFeed (Observability feed)', () => {
  it('paginates newest-first with a correct nextOffset chain', async () => {
    const agentId = await seedAgent();
    // 5 ratings; ts sorts so we can assert order (created_at DESC, id DESC).
    for (let i = 0; i < 5; i++) {
      await recordMessageFeedback({ agentId, messageTs: `m${i}`, raterUserId: `u${i}`, sentiment: i % 2 ? 'down' : 'up' });
    }
    const p1 = await getFeedbackFeed({ agentId }, 2, 0);
    expect(p1.total).toBe(5);
    expect(p1.items).toHaveLength(2);
    expect(p1.nextOffset).toBe(2);

    const p2 = await getFeedbackFeed({ agentId }, 2, p1.nextOffset!);
    expect(p2.items).toHaveLength(2);
    expect(p2.nextOffset).toBe(4);

    const p3 = await getFeedbackFeed({ agentId }, 2, p2.nextOffset!);
    expect(p3.items).toHaveLength(1);
    expect(p3.nextOffset).toBeNull(); // last page

    // No duplicates/gaps across the three pages.
    const ids = [...p1.items, ...p2.items, ...p3.items].map(i => i.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('filters by sentiment (total reflects the filter)', async () => {
    const agentId = await seedAgent();
    for (let i = 0; i < 3; i++) await recordMessageFeedback({ agentId, messageTs: `up${i}`, raterUserId: `u${i}`, sentiment: 'up' });
    await recordMessageFeedback({ agentId, messageTs: 'd0', raterUserId: 'd', sentiment: 'down', note: 'nope' });

    const down = await getFeedbackFeed({ agentId, sentiment: 'down' }, 20, 0);
    expect(down.total).toBe(1);
    expect(down.items).toEqual([expect.objectContaining({ sentiment: 'down', note: 'nope' })]);
  });

  it('scopes to accessibleAgentIds (RBAC): spans allowed agents, excludes others', async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const c = await seedAgent();
    await recordMessageFeedback({ agentId: a, messageTs: 'a', raterUserId: 'r', sentiment: 'up' });
    await recordMessageFeedback({ agentId: b, messageTs: 'b', raterUserId: 'r', sentiment: 'up' });
    await recordMessageFeedback({ agentId: c, messageTs: 'c', raterUserId: 'r', sentiment: 'down' });

    const feed = await getFeedbackFeed({ accessibleAgentIds: [a, b] }, 20, 0);
    expect(feed.total).toBe(2);
    expect(new Set(feed.items.map(i => i.agentId))).toEqual(new Set([a, b])); // c excluded
  });

  it('empty accessibleAgentIds means "sees nothing", never "all agents"', async () => {
    const a = await seedAgent();
    await recordMessageFeedback({ agentId: a, messageTs: 'a', raterUserId: 'r', sentiment: 'up' });
    const feed = await getFeedbackFeed({ accessibleAgentIds: [] }, 20, 0);
    expect(feed).toEqual({ items: [], total: 0, nextOffset: null, summary: { up: 0, down: 0 } });
  });

  it('summary carries scope-wide up/down (ignoring the sentiment filter); null past page 0', async () => {
    const agentId = await seedAgent();
    for (let i = 0; i < 3; i++) await recordMessageFeedback({ agentId, messageTs: `u${i}`, raterUserId: `u${i}`, sentiment: 'up' });
    await recordMessageFeedback({ agentId, messageTs: 'd0', raterUserId: 'd', sentiment: 'down' });

    // Filtered to 'down', but the summary still reflects ALL ratings in scope.
    const first = await getFeedbackFeed({ agentId, sentiment: 'down' }, 2, 0);
    expect(first.summary).toEqual({ up: 3, down: 1 });
    expect(first.total).toBe(1); // list total honors the filter

    // "Load more" (offset > 0) omits the summary — the caller keeps the first page's.
    const more = await getFeedbackFeed({ agentId }, 2, 2);
    expect(more.summary).toBeNull();
  });
});
