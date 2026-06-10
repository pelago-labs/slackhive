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
    postMessage: vi.fn(async () => 'anchor-ts'),
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
  it('pre-posts a thread anchor, injects a channel/thread header, and threads the result', async () => {
    const { agent, backend, adapter } = makeAgent('Here is your digest.');
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    // Anchor posted first (no thread parent) in the target channel.
    expect(adapter.postMessage).toHaveBeenCalledWith('C123', '*Daily digest*');

    // The prompt is prefixed with a [Sender: ...] header carrying channel + the
    // anchor ts as thread, then the original prompt body.
    expect(backend.streamQuery).toHaveBeenCalledTimes(1);
    const sentPrompt = backend.streamQuery.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('channel C123');
    expect(sentPrompt).toContain('thread anchor-ts');
    expect(sentPrompt.endsWith('Summarize today')).toBe(true);

    // Output posts as a reply under the anchor.
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'Here is your digest.' }, 'anchor-ts');
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'Here is your digest.');
  });

  it('routes DM jobs through openDm', async () => {
    const { agent, adapter } = makeAgent('dm result');
    const scheduler = new JobScheduler(() => agent as never);
    const dmJob = { ...(job as object), targetType: 'dm', targetId: 'U9' } as never;

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(dmJob);

    expect(adapter.openDm).toHaveBeenCalledWith('U9');
    expect(adapter.postMessage).toHaveBeenCalledWith('dm-U9', '*Daily digest*');
    expect(adapter.postPayload).toHaveBeenCalledWith('dm-U9', { text: 'dm result' }, 'anchor-ts');
  });

  it('falls back to inline thread parent when the anchor post fails', async () => {
    const { agent, backend, adapter } = makeAgent('Here is your digest.');
    adapter.postMessage.mockRejectedValueOnce(new Error('missing_scope'));
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    // No thread ts available → header omits the thread clause...
    const sentPrompt = backend.streamQuery.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('channel C123');
    expect(sentPrompt).not.toContain('thread ');
    // ...and the first payload posts as the parent (undefined thread arg).
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'Here is your digest.' }, undefined);
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'Here is your digest.');
  });

  it('skips silently when the target agent is not running', async () => {
    const scheduler = new JobScheduler(() => undefined);
    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);
    expect(insertJobRun).not.toHaveBeenCalled();
  });
});
