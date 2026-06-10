import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer the scheduler writes job runs to.
const insertJobRun = vi.fn(async () => 'run-1');
const updateJobRun = vi.fn(async () => {});
vi.mock('../db', () => ({
  getAllEnabledJobs: vi.fn(async () => []),
  insertJobRun: (...a: unknown[]) => insertJobRun(...a),
  updateJobRun: (...a: unknown[]) => updateJobRun(...a),
}));

import { JobScheduler, extractJobAttachments } from '../job-scheduler';

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
    uploadFile: vi.fn(async () => {}),
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

  it('posts the no-output fallback under the anchor when the run yields nothing', async () => {
    const { agent, backend, adapter } = makeAgent('unused');
    // Stream that emits neither assistant text nor a result → empty output.
    backend.streamQuery.mockImplementationOnce(() => {
      async function* silent() { yield { type: 'result', subtype: 'success', result: '' }; }
      return silent();
    });
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: '_Job completed with no output._' }, 'anchor-ts');
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', '_Job completed with no output._');
  });

  it('threads a failure note under the anchor when the run throws', async () => {
    const { agent, backend, adapter } = makeAgent('unused');
    backend.streamQuery.mockImplementationOnce(() => {
      async function* boom(): AsyncGenerator<never> { throw new Error('backend exploded'); }
      return boom();
    });
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    // Anchor was posted, run threw → a neutral note is threaded under the anchor
    // (raw error stays in the run record, not the channel).
    expect(adapter.postPayload).toHaveBeenCalledWith(
      'C123',
      { text: '_This scheduled job did not complete. The team has been notified._' },
      'anchor-ts',
    );
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'error', null, 'backend exploded');
  });

  it('posts the body first, then uploads embedded attachments after it', async () => {
    const out = 'L1 tables here\n\n<<<ATTACH filename="L2-2026-06-09.txt">>>\nL2 ascii body\n<<<END ATTACH>>>';
    const { agent, adapter } = makeAgent(out);
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    // Body posted with the marker block stripped out.
    expect(adapter.buildPayloads).toHaveBeenCalledWith('L1 tables here');
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'L1 tables here' }, 'anchor-ts');
    // File uploaded into the same thread, after the body.
    expect(adapter.uploadFile).toHaveBeenCalledWith('C123', 'L2 ascii body', 'L2-2026-06-09.txt', 'anchor-ts');
    // Ordering: the body post happens before the file upload.
    expect(adapter.postPayload.mock.invocationCallOrder[0])
      .toBeLessThan(adapter.uploadFile.mock.invocationCallOrder[0]);
  });

  it('does not upload anything when the output has no attachment markers', async () => {
    const { agent, adapter } = makeAgent('just a plain digest');
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);

    expect(adapter.uploadFile).not.toHaveBeenCalled();
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'just a plain digest' }, 'anchor-ts');
  });

  it('skips silently when the target agent is not running', async () => {
    const scheduler = new JobScheduler(() => undefined);
    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);
    expect(insertJobRun).not.toHaveBeenCalled();
  });
});

describe('extractJobAttachments', () => {
  it('returns passthrough body and no attachments when there are no markers', () => {
    expect(extractJobAttachments('plain text')).toEqual({ body: 'plain text', attachments: [] });
  });

  it('extracts a single attachment and strips it from the body', () => {
    const text = 'before\n\n<<<ATTACH filename="a.txt">>>\nfile A\n<<<END ATTACH>>>';
    expect(extractJobAttachments(text)).toEqual({
      body: 'before',
      attachments: [{ filename: 'a.txt', content: 'file A' }],
    });
  });

  it('extracts multiple attachments in order', () => {
    const text =
      'body\n<<<ATTACH filename="a.txt">>>\nAAA\n<<<END ATTACH>>>\n<<<ATTACH filename="b.txt">>>\nBBB\n<<<END ATTACH>>>';
    const { attachments } = extractJobAttachments(text);
    expect(attachments).toEqual([
      { filename: 'a.txt', content: 'AAA' },
      { filename: 'b.txt', content: 'BBB' },
    ]);
  });

  it('preserves multi-line content inside the marker', () => {
    const text = '<<<ATTACH filename="t.txt">>>\nline1\nline2\nline3\n<<<END ATTACH>>>';
    expect(extractJobAttachments(text).attachments[0].content).toBe('line1\nline2\nline3');
  });
});
