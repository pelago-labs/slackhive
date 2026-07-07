/**
 * @fileoverview Integration tests for the memory-reflection / auto-extraction
 * pass. Runs against a real throwaway SQLite DB (schema + migrations, so the
 * new pinned/scope columns exist) and mocks only the LLM call (generateText),
 * exercising the full extract → curate → dedup → upsert path end to end.
 *
 * @module runner/__tests__/memory-extraction.integration.test
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSqliteAdapter, setDb, getDb, closeDb,
  upsertTask, beginActivity, recordMessageFeedback, getFeedbackForThread, buildTaskId,
  type Agent,
} from '@slackhive/shared';
import { getAgentMemories, upsertMemory } from '../db';
import { extractMemories } from '../memory-extraction';

// Mock only the LLM — everything else is real (DB, dedup, upsert).
vi.mock('../backends/generate-text', () => ({ generateText: vi.fn() }));
import { generateText } from '../backends/generate-text';
const mockGen = generateText as unknown as ReturnType<typeof vi.fn>;

let dbPath: string;

async function seedAgent(): Promise<Agent> {
  const id = randomUUID();
  const slug = `slug-${id.slice(0, 8)}`;
  await getDb().query(
    `INSERT INTO agents (id, slug, name, persona, description, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, slug, 'Test Agent', null, null, 'claude-opus-4-8'],
  );
  return { id, slug, name: 'Test Agent' } as unknown as Agent;
}

/** Make generateText return a fixed proposal set as JSON. */
function proposals(memories: unknown[]): void {
  mockGen.mockResolvedValueOnce(JSON.stringify({ memories }));
}

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-extraction-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
  mockGen.mockReset();
});

afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('extractMemories', () => {
  it('saves a new durable memory from the transcript', async () => {
    const agent = await seedAgent();
    proposals([{ name: 'gmv_excludes_cancelled', type: 'reference', content: 'GMV excludes cancelled bookings.', reason: 'stated rule' }]);

    const res = await extractMemories(agent, 'user: how is GMV computed?\nagent: it excludes cancelled bookings', [], []);

    expect(res.applied).toBe(1);
    const mems = await getAgentMemories(agent.id);
    expect(mems).toHaveLength(1);
    expect(mems[0].name).toBe('gmv_excludes_cancelled');
    expect(mems[0].type).toBe('reference');
    expect(mems[0].content).toContain('excludes cancelled');
  });

  it('does nothing on an empty proposal list', async () => {
    const agent = await seedAgent();
    proposals([]);
    const res = await extractMemories(agent, 'user: hi\nagent: hello', [], []);
    expect(res.applied).toBe(0);
    expect(await getAgentMemories(agent.id)).toHaveLength(0);
  });

  it('dedups a near-duplicate into an UPDATE of the existing memory (no twin row)', async () => {
    const agent = await seedAgent();
    await upsertMemory(agent.id, 'reference', 'gmv_rule', 'GMV excludes cancelled bookings and refunds.');
    const existing = await getAgentMemories(agent.id);
    // A proposal with a different name but near-identical content.
    proposals([{ name: 'gmv_cancelled', type: 'reference', content: 'GMV excludes cancelled bookings and refunds entirely.', reason: 'dup' }]);

    const res = await extractMemories(agent, 'transcript', existing, []);

    expect(res.applied).toBe(1);
    const mems = await getAgentMemories(agent.id);
    expect(mems).toHaveLength(1);            // updated, not duplicated
    expect(mems[0].name).toBe('gmv_rule');   // reused the existing name
    expect(mems[0].content).toContain('entirely');
  });

  it('caps at 3 per run', async () => {
    const agent = await seedAgent();
    proposals(Array.from({ length: 6 }, (_, i) => ({ name: `m_${i}`, type: 'reference', content: `fact number ${i} about distinct thing ${i}`, reason: 'x' })));
    const res = await extractMemories(agent, 'transcript', [], []);
    expect(res.applied).toBe(3);
    expect(await getAgentMemories(agent.id)).toHaveLength(3);
  });

  it('skips invalid type and empty content', async () => {
    const agent = await seedAgent();
    proposals([
      { name: 'bad_type', type: 'nonsense', content: 'x' },
      { name: 'empty', type: 'reference', content: '   ' },
      { name: 'ok', type: 'user', content: 'Alex prefers metric units.' },
    ]);
    const res = await extractMemories(agent, 'transcript', [], []);
    expect(res.applied).toBe(1);
    const mems = await getAgentMemories(agent.id);
    expect(mems.map(m => m.name)).toEqual(['ok']);
  });

  it('sets scopeUserId only for the sole verified participant', async () => {
    const agent = await seedAgent();
    proposals([
      { name: 'scoped', type: 'user', content: 'Prefers SQL over charts.', scope_user: 'U012ABCDEF' },
      { name: 'notscoped', type: 'user', content: 'Likes concise answers.', scope_user: 'alex' },
    ]);
    await extractMemories(agent, 'transcript', [], [], [], { participantIds: ['U012ABCDEF'] });
    const mems = await getAgentMemories(agent.id);
    expect(mems.find(m => m.name === 'scoped')!.scopeUserId).toBe('U012ABCDEF');
    expect(mems.find(m => m.name === 'notscoped')!.scopeUserId).toBeNull();
  });

  it('SECURITY: refuses to scope a memory to someone other than the sole participant', async () => {
    const agent = await seedAgent();
    // Attacker U_ATTACKER tries to plant a memory scoped to victim U_VICTIM.
    proposals([{ name: 'planted', type: 'user', content: 'victim always wants X', scope_user: 'U_VICTIM99' }]);
    await extractMemories(agent, 'transcript', [], [], [], { participantIds: ['U_ATTACKER1'] });
    const m = (await getAgentMemories(agent.id))[0];
    expect(m.scopeUserId).toBeNull(); // dropped to global — not scoped to the victim
  });

  it('SECURITY: drops user-scope in a multi-party thread (ambiguous/injectable)', async () => {
    const agent = await seedAgent();
    proposals([{ name: 'pref', type: 'user', content: 'prefers short', scope_user: 'U_A0000001' }]);
    await extractMemories(agent, 'transcript', [], [], [], { participantIds: ['U_A0000001', 'U_B0000002'] });
    expect((await getAgentMemories(agent.id))[0].scopeUserId).toBeNull();
  });

  it('stamps provenance (source=reflection, created_by)', async () => {
    const agent = await seedAgent();
    proposals([{ name: 'rule', type: 'reference', content: 'a durable fact about the schema' }]);
    await extractMemories(agent, 'transcript', [], [], [], { createdBy: 'U_CREATOR1' });
    const m = (await getAgentMemories(agent.id))[0];
    expect(m.source).toBe('reflection');
    expect(m.createdBy).toBe('U_CREATOR1');
  });

  it('scopes a memory to a group when the extractor names a real group', async () => {
    const agent = await seedAgent();
    const groupId = randomUUID();
    await getDb().query(
      'INSERT INTO agent_groups (id, agent_id, name, priority) VALUES ($1, $2, $3, $4)',
      [groupId, agent.id, 'finance', 10],
    );
    proposals([{ name: 'sgd_reporting', type: 'project', content: 'Finance reports GMV in SGD.', scope_group: 'finance' }]);

    await extractMemories(agent, 'transcript', [], [], [{ name: 'finance' }]);

    const m = (await getAgentMemories(agent.id))[0];
    expect(m.scopeGroupId).toBe(groupId);
    expect(m.scopeUserId).toBeNull();
  });

  it('falls back to global for an unknown group name', async () => {
    const agent = await seedAgent();
    proposals([{ name: 'x', type: 'project', content: 'unknown group fact', scope_group: 'nope' }]);
    await extractMemories(agent, 'transcript', [], [], []);
    const m = (await getAgentMemories(agent.id))[0];
    expect(m.scopeGroupId).toBeNull();
    expect(m.scopeUserId).toBeNull();
  });

  it('user-specific wins when both scope_user and scope_group are given', async () => {
    const agent = await seedAgent();
    const groupId = randomUUID();
    await getDb().query(
      'INSERT INTO agent_groups (id, agent_id, name, priority) VALUES ($1, $2, $3, $4)',
      [groupId, agent.id, 'finance', 10],
    );
    proposals([{ name: 'pref', type: 'user', content: 'Aman prefers short answers.', scope_user: 'U012ABCDEF', scope_group: 'finance' }]);
    await extractMemories(agent, 'transcript', [], [], [{ name: 'finance' }], { participantIds: ['U012ABCDEF'] });
    const m = (await getAgentMemories(agent.id))[0];
    expect(m.scopeUserId).toBe('U012ABCDEF');
    expect(m.scopeGroupId).toBeNull();
  });

  it('extracts a feedback-type correction when a 👎 note is present', async () => {
    const agent = await seedAgent();
    proposals([{ name: 'filter_published', type: 'feedback', content: 'When analyzing products, filter option_state=PUBLISHED — a user flagged the unfiltered version.', reason: 'thumbs-down note' }]);

    const res = await extractMemories(
      agent,
      'user: churn by product?\nagent: <numbers>',
      [],
      [{ sentiment: 'down', note: 'you should have filtered by PUBLISHED' }],
    );

    expect(res.applied).toBe(1);
    const mems = await getAgentMemories(agent.id);
    expect(mems[0].type).toBe('feedback');
    expect(mems[0].content).toContain('PUBLISHED');
  });

  it('returns 0 and never throws when the LLM call fails', async () => {
    const agent = await seedAgent();
    mockGen.mockRejectedValueOnce(new Error('provider down'));
    const res = await extractMemories(agent, 'transcript', [], []);
    expect(res.applied).toBe(0);
    expect(await getAgentMemories(agent.id)).toHaveLength(0);
  });

  it('returns 0 on unparseable LLM output', async () => {
    const agent = await seedAgent();
    mockGen.mockResolvedValueOnce('sorry, I cannot help with that');
    const res = await extractMemories(agent, 'transcript', [], []);
    expect(res.applied).toBe(0);
  });
});

describe('getFeedbackForThread', () => {
  it('returns 👍/👎 + notes scoped to the thread', async () => {
    const agent = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C1', threadTs: '100.0', initialAgentId: agent.id });
    expect(taskId).toBe(buildTaskId('slack', 'C1', '100.0'));
    const activityId = await beginActivity({ taskId, agentId: agent.id, platform: 'slack', initiatorKind: 'user' });
    await recordMessageFeedback({ agentId: agent.id, activityId, channel: 'C1', messageTs: '101.0', raterUserId: 'U1', sentiment: 'down', note: 'filter by PUBLISHED' });

    const fb = await getFeedbackForThread(agent.id, taskId);
    expect(fb).toEqual([{ sentiment: 'down', note: 'filter by PUBLISHED' }]);
  });

  it('returns [] for a thread with no feedback', async () => {
    const agent = await seedAgent();
    const taskId = await upsertTask({ platform: 'slack', channelId: 'C2', threadTs: '200.0', initialAgentId: agent.id });
    expect(await getFeedbackForThread(agent.id, taskId)).toEqual([]);
  });
});
