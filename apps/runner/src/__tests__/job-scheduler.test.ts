import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer the scheduler writes job runs to.
const insertJobRun = vi.fn(async () => 'run-1');
const updateJobRun = vi.fn(async () => {});
vi.mock('../db', () => ({
  getAllEnabledJobs: vi.fn(async () => []),
  insertJobRun: (...a: unknown[]) => insertJobRun(...a),
  updateJobRun: (...a: unknown[]) => updateJobRun(...a),
}));

import { JobScheduler, isSilent, notificationGate } from '../job-scheduler';
import { parseJobSentinel } from '@slackhive/shared';

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

const exec = (s: JobScheduler, j: unknown) =>
  (s as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(j);

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

  it('does not wedge a job when insertJobRun fails (no running-set leak)', async () => {
    // A DB blip recording the run must not leak job.id into `running`. First
    // tick: insert throws → run aborts cleanly. Second tick: insert works → the
    // job must actually run, proving it wasn't wedged as "overlapping".
    const { agent, adapter } = makeAgent('recovered');
    insertJobRun.mockRejectedValueOnce(new Error('db down'));
    const scheduler = new JobScheduler(() => agent as never);

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);
    expect(adapter.postMessage).not.toHaveBeenCalled(); // aborted before posting

    await (scheduler as unknown as { executeJob: (j: unknown) => Promise<void> }).executeJob(job);
    expect(insertJobRun).toHaveBeenCalledTimes(2);
    expect(adapter.updatePayload).toHaveBeenCalledWith('C123', 'anchor-ts', { text: 'recovered' });
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

describe('JobScheduler.executeJob — skipWhen suppression', () => {
  const skipJob = { ...(job as object), skipWhen: 'there are no fraud cases to report' } as never;

  it('injects the notification gate (condition + sentinel) into a suppressible job prompt', async () => {
    const { agent, backend } = makeAgent('NO_UPDATE: nothing changed');
    await exec(new JobScheduler(() => agent as never), skipJob);

    const sentPrompt = backend.streamQuery.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('Notification gate');
    expect(sentPrompt).toContain('there are no fraud cases to report');
    expect(sentPrompt).toContain('NO_UPDATE');
    // Original task body is still present, before the gate.
    expect(sentPrompt).toContain('Summarize today');
  });

  it('suppresses the post and records the run as not-posted (keeping the reason for debug)', async () => {
    const { agent, adapter } = makeAgent('NO_UPDATE: no new fraud cases today');
    await exec(new JobScheduler(() => agent as never), skipJob);

    // The whole point: nothing reaches Slack — not even the "running…" anchor
    // (pre-posting then deleting it would still ping the channel).
    expect(adapter.postMessage).not.toHaveBeenCalled();
    expect(adapter.postPayload).not.toHaveBeenCalled();
    expect(adapter.updatePayload).not.toHaveBeenCalled();
    // Recorded success-but-not-posted, with the full reply (incl. reason) for debugging.
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'NO_UPDATE: no new fraud cases today', null, false);
  });

  it('a suppressible job that DOES have output posts via the legacy parent path (no anchor)', async () => {
    const { agent, adapter } = makeAgent('Fraud cases rose to 12 — see breakdown.');
    await exec(new JobScheduler(() => agent as never), skipJob);

    // No pre-posted anchor (would ping), so the first payload becomes the parent.
    expect(adapter.postMessage).not.toHaveBeenCalled();
    expect(adapter.updatePayload).not.toHaveBeenCalled();
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'Fraud cases rose to 12 — see breakdown.' }, undefined);
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'Fraud cases rose to 12 — see breakdown.');
  });

  it('does not mistake natural prose containing "no update" for the sentinel', async () => {
    const { agent, adapter } = makeAgent('No update to the figures: still 42 open cases.');
    await exec(new JobScheduler(() => agent as never), skipJob);

    // The underscore token NO_UPDATE did not match → posts normally.
    expect(adapter.postPayload).toHaveBeenCalledWith('C123', { text: 'No update to the figures: still 42 open cases.' }, undefined);
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'success', 'No update to the figures: still 42 open cases.');
  });

  it('leaves a job without skipWhen completely unchanged (no gate, anchor pre-posted)', async () => {
    const { agent, backend, adapter } = makeAgent('Here is your digest.');
    await exec(new JobScheduler(() => agent as never), job);

    expect(backend.streamQuery.mock.calls[0][0]).not.toContain('Notification gate');
    expect(adapter.postMessage).toHaveBeenCalledWith('C123', '*Daily digest* · ⏳ _running…_');
    expect(adapter.updatePayload).toHaveBeenCalledWith('C123', 'anchor-ts', { text: 'Here is your digest.' });
  });

  it('surfaces a failure in-channel when a suppressible job errors (no silent breakage)', async () => {
    const { agent, backend, adapter } = makeAgent('unused');
    backend.streamQuery.mockImplementationOnce(() => {
      async function* boom(): AsyncGenerator<never> { throw new Error('query exploded'); }
      return boom();
    });
    await exec(new JobScheduler(() => agent as never), skipJob);

    // No anchor was pre-posted (suppressible), but an error must still be visible —
    // posted as a fresh failure line rather than vanishing into the logs.
    expect(adapter.postMessage).toHaveBeenCalledWith('C123', '*Daily digest* · ⚠️ _did not complete_');
    expect(updateJobRun).toHaveBeenCalledWith('run-1', 'error', null, 'query exploded');
  });
});

describe('isSilent — NO_UPDATE sentinel detection', () => {
  it.each([
    ['the bare token', 'NO_UPDATE'],
    ['lowercase', 'no_update'],
    ['surrounding whitespace', '  NO_UPDATE  '],
    ['wrapped in backticks', '`NO_UPDATE`'],
    ['bold markdown', '**NO_UPDATE**'],
    ['italic underscore markdown', '_NO_UPDATE_'],
    ['italic markdown with a reason', '_NO_UPDATE_: no new cases'],
    ['bold markdown with a reason', '**NO_UPDATE**: all clear'],
    ['blockquote prefix', '> NO_UPDATE'],
    ['with a trailing reason', 'NO_UPDATE: no fraud cases to report today'],
    ['reason after a dash', 'NO_UPDATE - everything nominal'],
  ])('treats %s as silent', (_label, output) => {
    expect(isSilent(output)).toBe(true);
  });

  it.each([
    ['empty output', ''],
    ['whitespace only', '   '],
    ['prose that merely says "no update"', 'No update to the figures: still 42 open cases.'],
    ['the token mid-sentence', 'The pipeline emitted NO_UPDATE for column 3, here is the report.'],
    ['a normal report', 'Fraud cases rose to 12 — see the breakdown below.'],
    ['a hyphenated lookalike', 'NO-UPDATE today'],
    ['a longer word starting with the token', 'NO_UPDATED the records successfully.'],
  ])('does NOT treat %s as silent', (_label, output) => {
    expect(isSilent(output)).toBe(false);
  });
});

describe('parseJobSentinel — reason extraction (run-history debug view)', () => {
  it.each([
    ['bare token → empty reason', 'NO_UPDATE', ''],
    ['colon-separated reason', 'NO_UPDATE: no new fraud cases', 'no new fraud cases'],
    ['dash-separated reason', 'NO_UPDATE - all clear', 'all clear'],
    ['markdown-wrapped with reason', '_NO_UPDATE_: nothing changed', 'nothing changed'],
    ['multi-line reply collapses to one line', 'NO_UPDATE\n\nNo rows returned\nfrom the query', 'No rows returned from the query'],
    ['stray-period delimiter is consumed', 'NO_UPDATE. done', 'done'],
  ])('%s', (_label, output, expected) => {
    const parsed = parseJobSentinel(output);
    expect(parsed.silent).toBe(true);
    expect(parsed.reason).toBe(expected);
  });

  it('returns silent=false (and empty reason) for non-sentinel output', () => {
    expect(parseJobSentinel('Here is the full report.')).toEqual({ silent: false, reason: '' });
    expect(parseJobSentinel(null)).toEqual({ silent: false, reason: '' });
  });
});

describe('notificationGate — injected skip instruction', () => {
  it('embeds the condition and the sentinel token, and marks itself as a gate', () => {
    const gate = notificationGate('the report has no rows');
    expect(gate).toContain('Notification gate');
    expect(gate).toContain('the report has no rows');
    expect(gate).toContain('NO_UPDATE');
  });

  it('trims surrounding whitespace from the condition', () => {
    expect(notificationGate('   nothing to report   ')).toContain('"nothing to report"');
  });
});
