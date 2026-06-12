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
    updatePayload: vi.fn(async () => {}),
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

    // Anchor posted first (no thread parent) in the target channel, with a
    // "running…" hint that gets overwritten by the result.
    expect(adapter.postMessage).toHaveBeenCalledWith('C123', '*Daily digest* · ⏳ _running…_');

    // The anchor must exist BEFORE the run so the agent can upload into the
    // thread mid-run — assert the anchor post precedes streamQuery.
    expect(adapter.postMessage.mock.invocationCallOrder[0])
      .toBeLessThan(backend.streamQuery.mock.invocationCallOrder[0]);

    // The prompt is prefixed with a [Sender: ...] header carrying channel + the
    // anchor ts as thread, then the original prompt body.
    expect(backend.streamQuery).toHaveBeenCalledTimes(1);
    const sentPrompt = backend.streamQuery.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('channel C123');
    expect(sentPrompt).toContain('thread anchor-ts');
    expect(sentPrompt.endsWith('Summarize today')).toBe(true);

    // Single-table output → promoted INTO the anchor (becomes the parent
    // message), not threaded as a reply.
    expect(adapter.updatePayload).toHaveBeenCalledWith('C123', 'anchor-ts', { text: 'Here is your digest.' });
    expect(adapter.postPayload).not.toHaveBeenCalled();
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'Here is your digest.');
  });

  it('promotes the first table into the anchor and threads the remaining tables', async () => {
    const { agent, adapter } = makeAgent('headline\n\ndetail');
    // Simulate buildPayloads splitting the output into one payload per table.
    adapter.buildPayloads.mockReturnValueOnce([{ text: 'L1.0 table' }, { text: 'L1.2 table' }]);
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    // Headline table is swapped INTO the anchor → it's the top-level message.
    expect(adapter.updatePayload).toHaveBeenCalledWith('C123', 'anchor-ts', { text: 'L1.0 table' });
    // Remaining tables thread under the anchor…
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'L1.2 table' }, 'anchor-ts');
    // …and the headline is NOT also re-posted as a reply.
    expect(adapter.postPayload).not.toHaveBeenCalledWith('C123', { text: 'L1.0 table' }, 'anchor-ts');
  });

  it('routes DM jobs through openDm', async () => {
    const { agent, adapter } = makeAgent('dm result');
    const scheduler = new JobScheduler(() => agent as never);
    const dmJob = { ...(job as object), targetType: 'dm', targetId: 'U9' } as never;

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(dmJob);

    expect(adapter.openDm).toHaveBeenCalledWith('U9');
    expect(adapter.postMessage).toHaveBeenCalledWith('dm-U9', '*Daily digest* · ⏳ _running…_');
    expect(adapter.updatePayload).toHaveBeenCalledWith('dm-U9', 'anchor-ts', { text: 'dm result' });
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
    // ...and with no anchor to promote into, the first payload posts as the
    // parent (undefined thread arg) — legacy fallback, no in-place update.
    expect(adapter.updatePayload).not.toHaveBeenCalled();
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'Here is your digest.' }, undefined);
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'Here is your digest.');
  });

  it('posts the no-output fallback under the anchor when the run yields nothing', async () => {
    const { agent, backend, adapter } = makeAgent('unused');
    // Stream that emits neither assistant text nor a result → empty output.
    backend.streamQuery.mockImplementationOnce(() => {
      async function* silent() { yield { type: 'result', subtype: 'success', result: '' }; }
      return silent();
    });
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    expect(adapter.updatePayload).toHaveBeenCalledWith('C123', 'anchor-ts', { text: '_Job completed with no output._' });
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', '_Job completed with no output._');
  });

  it('resolves the anchor to a failure state when the run throws', async () => {
    const { agent, backend, adapter } = makeAgent('unused');
    backend.streamQuery.mockImplementationOnce(() => {
      async function* boom(): AsyncGenerator<never> { throw new Error('backend exploded'); }
      return boom();
    });
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    // Run threw before any output → the "running…" anchor is rewritten in place
    // to a neutral failure line (so it isn't left stuck), not a thread reply.
    // The raw error stays in the run record, not the channel.
    expect(adapter.updatePayload).toHaveBeenCalledWith(
      'C123', 'anchor-ts', { text: '*Daily digest* · ⚠️ _did not complete_' },
    );
    expect(adapter.postPayload).not.toHaveBeenCalled();
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'error', null, 'backend exploded');
  });

  it('does NOT overwrite the anchor with a failure state once real output was promoted in', async () => {
    const { agent, adapter } = makeAgent('headline\n\ndetail');
    adapter.buildPayloads.mockReturnValueOnce([{ text: 'L1.0 table' }, { text: 'L1.2 table' }]);
    // Headline promotes fine; threading a later sub-table fails.
    adapter.postPayload.mockRejectedValueOnce(new Error('rate_limited'));
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    // Anchor holds the real headline — the catch must NOT clobber it with the
    // failure line. updatePayload was called only to promote L1.0.
    expect(adapter.updatePayload).toHaveBeenCalledTimes(1);
    expect(adapter.updatePayload).toHaveBeenCalledWith('C123', 'anchor-ts', { text: 'L1.0 table' });
    expect(adapter.updatePayload).not.toHaveBeenCalledWith(
      'C123', 'anchor-ts', { text: '*Daily digest* · ⚠️ _did not complete_' },
    );
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'error', null, 'rate_limited');
  });

  it('falls back to a thread reply when promoting the headline into the anchor fails', async () => {
    const { agent, adapter } = makeAgent('Here is your digest.');
    // chat.update rejects with something other than invalid_blocks (e.g. the
    // anchor was deleted, or a transient error). The run itself succeeded.
    adapter.updatePayload.mockRejectedValueOnce(new Error('message_not_found'));
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    // Headline degrades to a thread reply so the content still lands…
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'Here is your digest.' }, 'anchor-ts');
    // …the run is still recorded success (a failed promotion must not fail the run)…
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'Here is your digest.');
    // …and no scary "did not complete" note is posted.
    expect(adapter.postPayload).not.toHaveBeenCalledWith(
      'C123',
      { text: '_This scheduled job did not complete. The team has been notified._' },
      'anchor-ts',
    );
  });

  it('skips silently when the target agent is not running', async () => {
    const scheduler = new JobScheduler(() => undefined);
    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);
    expect(insertJobRun).not.toHaveBeenCalled();
  });

  it('does not wedge a job when the agent was briefly down (no running-set leak)', async () => {
    // First tick: agent down → skipped. Second tick: agent back → must actually
    // run. If executeJob leaked job.id into `running` on the skip path, the
    // second tick would be dropped as an "overlapping" run and never fire.
    const { agent } = makeAgent('recovered');
    let agentUp = false;
    const scheduler = new JobScheduler(() => (agentUp ? (agent as never) : undefined));

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);
    expect(insertJobRun).not.toHaveBeenCalled(); // skipped while down

    agentUp = true;
    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);
    expect(insertJobRun).toHaveBeenCalledTimes(1); // ran once the agent returned
  });
});
