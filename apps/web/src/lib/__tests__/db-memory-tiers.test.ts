/**
 * @fileoverview Real-DB round-trip test for the memory-tier fields the Memories
 * tab reads/writes: pinned + scope (user/group). Exercises the exact web db
 * functions the /api/agents/[id]/memories routes call, against a throwaway
 * SQLite DB (schema + migrations), so a schema/mapping bug can't hide.
 *
 * @module web/lib/__tests__/db-memory-tiers.test
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter, setDb, getDb, closeDb } from '@slackhive/shared';
import { upsertMemory, getAgentMemories, deleteMemory, updateMemoryTier } from '@/lib/db';

let dbPath: string;

async function seedAgent(): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    'INSERT INTO agents (id, slug, name, model) VALUES ($1, $2, $3, $4)',
    [id, `slug-${id.slice(0, 8)}`, 'Test Agent', 'claude-opus-4-8'],
  );
  return id;
}

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-memory-tiers-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});

afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('memory tier fields (web db, real SQLite)', () => {
  it('persists and returns pinned + user/group scope', async () => {
    const agentId = await seedAgent();

    const pinned = await upsertMemory(agentId, 'feedback', 'rule', 'always exclude cancelled', { pinned: true });
    expect(pinned.pinned).toBe(true);
    expect(pinned.scopeUserId).toBeNull();

    await upsertMemory(agentId, 'user', 'pref', 'aman likes short', { scopeUserId: 'U08AMAN9Z' });
    await upsertMemory(agentId, 'project', 'sgd', 'finance in SGD', { scopeGroupId: 'grp-1' });

    const mems = await getAgentMemories(agentId);
    expect(mems.find(m => m.name === 'rule')!.pinned).toBe(true);
    expect(mems.find(m => m.name === 'pref')!.scopeUserId).toBe('U08AMAN9Z');
    expect(mems.find(m => m.name === 'sgd')!.scopeGroupId).toBe('grp-1');
    // Default (no opts) → unpinned + global.
    await upsertMemory(agentId, 'reference', 'plain', 'a global fact');
    const plain = (await getAgentMemories(agentId)).find(m => m.name === 'plain')!;
    expect(plain.pinned).toBe(false);
    expect(plain.scopeUserId).toBeNull();
    expect(plain.scopeGroupId).toBeNull();
  });

  it('updates tier fields on conflict (pin toggle by re-upserting the same name)', async () => {
    const agentId = await seedAgent();
    await upsertMemory(agentId, 'feedback', 'rule', 'body', { pinned: true, scopeUserId: 'U1' });
    // The "Unpin" + "Everyone" action in the UI re-upserts with cleared tiers.
    await upsertMemory(agentId, 'feedback', 'rule', 'body', { pinned: false, scopeUserId: null, scopeGroupId: null });

    const mems = await getAgentMemories(agentId);
    expect(mems).toHaveLength(1);              // updated, not duplicated
    expect(mems[0].pinned).toBe(false);
    expect(mems[0].scopeUserId).toBeNull();
  });

  it('updateMemoryTier changes only tier fields, not content/type', async () => {
    const agentId = await seedAgent();
    const m = await upsertMemory(agentId, 'reference', 'r', 'original content');
    await updateMemoryTier(m.id, { pinned: true, scopeUserId: 'U9', scopeGroupId: null });
    const after = (await getAgentMemories(agentId))[0];
    expect(after.pinned).toBe(true);
    expect(after.scopeUserId).toBe('U9');
    expect(after.type).toBe('reference');
    expect(after.content).toBe('original content'); // untouched
  });

  it('delete removes the row', async () => {
    const agentId = await seedAgent();
    const m = await upsertMemory(agentId, 'reference', 'x', 'y');
    await deleteMemory(m.id);
    expect(await getAgentMemories(agentId)).toHaveLength(0);
  });
});
