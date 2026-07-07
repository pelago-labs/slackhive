/**
 * @fileoverview Integration tests for the reconcile / self-review pass (Phase 2),
 * against a real SQLite DB with the LLM mocked. Verifies safe cleanup: dedup
 * DELETE, merge UPDATE, never-touch-pinned, suggest vs apply, op cap.
 *
 * @module runner/__tests__/memory-reconcile.integration.test
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteAdapter, setDb, getDb, closeDb, type Agent } from '@slackhive/shared';
import { getAgentMemories, upsertMemory } from '../db';
import { reconcileMemories } from '../memory-reconcile';

vi.mock('../backends/generate-text', () => ({ generateText: vi.fn() }));
import { generateText } from '../backends/generate-text';
const mockGen = generateText as unknown as ReturnType<typeof vi.fn>;

let dbPath: string;

async function seedAgent(): Promise<Agent> {
  const id = randomUUID();
  const slug = `slug-${id.slice(0, 8)}`;
  await getDb().query('INSERT INTO agents (id, slug, name, model) VALUES ($1,$2,$3,$4)', [id, slug, 'T', 'claude-opus-4-8']);
  return { id, slug, name: 'T' } as unknown as Agent;
}
function ops(o: unknown[]): void { mockGen.mockResolvedValueOnce(JSON.stringify({ ops: o })); }

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reconcile-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
  mockGen.mockReset();
});
afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('reconcileMemories', () => {
  it('does not call the LLM for < 2 memories', async () => {
    const agent = await seedAgent();
    await upsertMemory(agent.id, 'reference', 'a', 'only one');
    const res = await reconcileMemories(agent, await getAgentMemories(agent.id), { apply: true });
    expect(mockGen).not.toHaveBeenCalled();
    expect(res.applied).toBe(0);
  });

  it('deletes a duplicate (DELETE op)', async () => {
    const agent = await seedAgent();
    await upsertMemory(agent.id, 'reference', 'gmv_a', 'GMV excludes cancelled bookings.');
    const dup = await upsertMemory(agent.id, 'reference', 'gmv_b', 'GMV excludes cancelled bookings entirely.');
    ops([{ action: 'DELETE', id: dup.id, reason: 'duplicate of gmv_a' }]);

    const res = await reconcileMemories(agent, await getAgentMemories(agent.id), { apply: true });
    expect(res.applied).toBe(1);
    const names = (await getAgentMemories(agent.id)).map(m => m.name);
    expect(names).toEqual(['gmv_a']);
  });

  it('merges via UPDATE, preserving tier/provenance', async () => {
    const agent = await seedAgent();
    const survivor = await upsertMemory(agent.id, 'user', 'pref', 'short answers', { scopeUserId: 'U1', source: 'reflection', createdBy: 'U1' });
    await upsertMemory(agent.id, 'user', 'pref2', 'short answers, no sql');
    ops([{ action: 'UPDATE', id: survivor.id, content: 'short answers, no SQL', reason: 'merge' }]);

    await reconcileMemories(agent, await getAgentMemories(agent.id), { apply: true });
    const m = (await getAgentMemories(agent.id)).find(x => x.name === 'pref')!;
    expect(m.content).toBe('short answers, no SQL');
    expect(m.scopeUserId).toBe('U1');   // tier preserved
    expect(m.source).toBe('reflection'); // provenance preserved
  });

  it('NEVER deletes a pinned memory even if the LLM says to', async () => {
    const agent = await seedAgent();
    const pinned = await upsertMemory(agent.id, 'feedback', 'rule', 'critical rule', { pinned: true });
    await upsertMemory(agent.id, 'reference', 'other', 'something else');
    ops([{ action: 'DELETE', id: pinned.id, reason: 'model wrongly wants this gone' }]);

    const res = await reconcileMemories(agent, await getAgentMemories(agent.id), { apply: true });
    expect(res.applied).toBe(0);
    expect((await getAgentMemories(agent.id)).some(m => m.name === 'rule')).toBe(true);
  });

  it('suggest mode (apply=false) returns ops but changes nothing', async () => {
    const agent = await seedAgent();
    const a = await upsertMemory(agent.id, 'reference', 'a', 'x');
    await upsertMemory(agent.id, 'reference', 'b', 'x duplicate');
    ops([{ action: 'DELETE', id: a.id, reason: 'dup' }]);

    const res = await reconcileMemories(agent, await getAgentMemories(agent.id), { apply: false });
    expect(res.ops).toHaveLength(1);
    expect(res.applied).toBe(0);
    expect(await getAgentMemories(agent.id)).toHaveLength(2); // untouched
  });

  it('caps applied ops at 8', async () => {
    const agent = await seedAgent();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await upsertMemory(agent.id, 'reference', `m${i}`, `dup ${i}`)).id);
    ops(ids.map(id => ({ action: 'DELETE', id, reason: 'dup' })));
    const res = await reconcileMemories(agent, await getAgentMemories(agent.id), { apply: true });
    expect(res.applied).toBe(8);
  });

  it('applies valid ops behind skipped (pinned) ops — cap counts applied, not proposed', async () => {
    const agent = await seedAgent();
    const pinnedIds: string[] = [];
    for (let i = 0; i < 8; i++) pinnedIds.push((await upsertMemory(agent.id, 'feedback', `p${i}`, `pinned ${i}`, { pinned: true })).id);
    const dup = await upsertMemory(agent.id, 'reference', 'dup', 'a duplicate to remove');
    // 8 DELETEs targeting pinned (all skipped) followed by one valid DELETE.
    ops([...pinnedIds.map(id => ({ action: 'DELETE', id, reason: 'x' })), { action: 'DELETE', id: dup.id, reason: 'dup' }]);

    const res = await reconcileMemories(agent, await getAgentMemories(agent.id), { apply: true });
    expect(res.applied).toBe(1); // the valid delete is NOT crowded out by the 8 skipped
    const after = await getAgentMemories(agent.id);
    expect(after.some(m => m.name === 'dup')).toBe(false);
    expect(after.filter(m => m.pinned).length).toBe(8); // pinned all survive
  });

  it('ignores ops with an unknown id', async () => {
    const agent = await seedAgent();
    await upsertMemory(agent.id, 'reference', 'a', 'x');
    await upsertMemory(agent.id, 'reference', 'b', 'y');
    ops([{ action: 'DELETE', id: 'does-not-exist', reason: 'x' }]);
    const res = await reconcileMemories(agent, await getAgentMemories(agent.id), { apply: true });
    expect(res.applied).toBe(0);
    expect(await getAgentMemories(agent.id)).toHaveLength(2);
  });
});
