import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer the scheduler writes job runs to.
const insertJobRun = vi.fn(async () => 'run-1');
const updateJobRun = vi.fn(async () => {});
vi.mock('../db', () => ({
  getAllEnabledJobs: vi.fn(async () => []),
  insertJobRun: (...a: unknown[]) => insertJobRun(...a),
  updateJobRun: (...a: unknown[]) => updateJobRun(...a),
}));

import { JobScheduler } from '../job-scheduler';

function makeAgent(resultText: string) {
  async function* stream() {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } };
    yield { type: 'result', subtype: 'success', result: resultText };
  }
  const backend = { backend: 'codex', streamQuery: vi.fn(() => stream()) };
  const adapter = {
    openDm: vi.fn(async (id: string) => `dm-${id}`),
    buildPayloads: vi.fn((text: string) => [{ text }]),
    postPayload: vi.fn(async () => 'posted'),
  };
  return { agent: { backend, adapter }, backend, adapter };
}

const job = {
  id: 'job-1', agentId: 'agent-1', name: 'Daily digest',
  prompt: 'Summarize today', cronSchedule: '0 9 * * *',
  targetType: 'channel', targetId: 'C123',
} as never;

beforeEach(() => { insertJobRun.mockClear(); updateJobRun.mockClear(); });

describe('JobScheduler.executeJob (backend-agnostic)', () => {
  it('streams the prompt through the running agent backend and posts the result', async () => {
    const { agent, backend, adapter } = makeAgent('Here is your digest.');
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    expect(backend.streamQuery).toHaveBeenCalledTimes(1);
    expect(backend.streamQuery.mock.calls[0][0]).toBe('Summarize today');
    // 3rd arg is the thread parent ts — undefined for the first (parent) post.
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'Here is your digest.' }, undefined);
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'Here is your digest.');
  });

  it('routes DM jobs through openDm', async () => {
    const { agent, adapter } = makeAgent('dm result');
    const scheduler = new JobScheduler(() => agent as never);
    const dmJob = { ...(job as object), targetType: 'dm', targetId: 'U9' } as never;

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(dmJob);

    expect(adapter.openDm).toHaveBeenCalledWith('U9');
    expect(adapter.postPayload).toHaveBeenCalledWith('dm-U9', { text: 'dm result' }, undefined);
  });

  it('skips silently when the target agent is not running', async () => {
    const scheduler = new JobScheduler(() => undefined);
    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);
    expect(insertJobRun).not.toHaveBeenCalled();
  });
});
