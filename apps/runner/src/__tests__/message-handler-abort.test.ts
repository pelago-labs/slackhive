/**
 * @fileoverview Regression tests for the same-thread abort path in
 * MessageHandler.handleMessage.
 *
 * The bug we're guarding against: when a user sends a second message in the
 * same thread while the first is still streaming, the existing code at
 * `message-handler.ts:108` fires `controller.abort()`. The for-await loop
 * sees `signal.aborted` and breaks, but then control falls through to the
 * post-loop success path which posts a "_No response generated._" fallback
 * and marks the activity as `done`. The Claude SDK's `query()` generator
 * does NOT throw `AbortError` on consumer break-out — it returns silently —
 * so the existing catch branch never fires for interrupted runs.
 *
 * The fix is a 4-line throw after the loop that promotes `signal.aborted`
 * into an `AbortError`, routing it into the same catch branch that already
 * marks the activity `error/aborted` and swaps the Slack reaction to
 * `:stop_button:`.
 *
 * These tests use the `test` platform so userCanTrigger and activity
 * recording are bypassed (we don't need a DB to verify the fix). The
 * adapter signal — `swapReaction('stop_button')` vs `'white_check_mark'`,
 * and whether the fallback message gets posted — is what tells us which
 * branch ran.
 *
 * @module runner/__tests__/message-handler-abort
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, IncomingMessage, PlatformAdapter } from '@slackhive/shared';
import { MessageHandler } from '../message-handler';
import type { ClaudeHandler } from '../claude-handler';

const FALLBACK_TEXT = '_No response generated._';

function makeAdapter(): PlatformAdapter {
  return {
    platform: 'test',
    formattingRules: '',
    postMessage: vi.fn(async () => 'msg-id'),
    postPayload: vi.fn(async () => 'msg-id'),
    updateMessage: vi.fn(async () => undefined),
    postReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => []),
    getUserDisplayName: vi.fn(async () => 'tester'),
    downloadFile: vi.fn(async () => null),
    resolveLinkedMessage: vi.fn(async () => null),
    buildPayloads: vi.fn((text: string) => [{ text }]),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as PlatformAdapter;
}

/**
 * Build a fake ClaudeHandler. By default `streamQuery` yields nothing and
 * returns immediately. Tests override `mockImplementation` per-case to
 * control the stream's lifecycle (hang-until-abort vs. instant-return).
 */
function makeClaudeHandler(): ClaudeHandler {
  return {
    getSessionKey: (userId: string, channelId: string, threadTs?: string) =>
      `${userId}-${channelId}-${threadTs ?? 'direct'}`,
    // eslint-disable-next-line require-yield
    streamQuery: vi.fn(async function* () { return; }),
  } as unknown as ClaudeHandler;
}

/** Async generator that hangs until `ctl.signal.aborted` flips. */
async function* hangUntilAborted(ctl?: AbortController): AsyncGenerator<unknown, void, unknown> {
  while (!ctl?.signal.aborted) {
    await new Promise(r => setTimeout(r, 10));
  }
  // SDK's "silent return on consumer break" semantics — never throws.
}

/** Like `hangUntilAborted` but returns after `maxTicks` even if never aborted,
 *  so a test can't hang forever when the abort it expects fails to arrive. */
async function* hangUntilAbortedOrTimeout(ctl?: AbortController, maxTicks = 100): AsyncGenerator<unknown, void, unknown> {
  let ticks = 0;
  while (!ctl?.signal.aborted && ticks < maxTicks) {
    await new Promise(r => setTimeout(r, 5));
    ticks++;
  }
}

function makeAgent(): Agent {
  return {
    id: 'agent-test',
    slug: 'test-agent',
    name: 'Test',
    persona: null,
    description: null,
    model: 'claude-opus-4-7',
    status: 'running',
    enabled: true,
    isBoss: false,
    verbose: false,
    reportsTo: [],
    tags: [],
    claudeMd: '',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    slackBotToken: '',
    slackAppToken: '',
    slackSigningSecret: '',
  } as unknown as Agent;
}

function makeMsg(id: string, text = 'hello'): IncomingMessage {
  return {
    id,
    platform: 'test',
    userId: 'U_test',
    channelId: 'C_test',
    threadId: 't_thread',
    text,
    isDM: false,
    raw: {},
  } as unknown as IncomingMessage;
}

let handler: MessageHandler;
let adapter: ReturnType<typeof makeAdapter>;
let claude: ReturnType<typeof makeClaudeHandler>;

beforeEach(() => {
  adapter = makeAdapter();
  claude = makeClaudeHandler();
  handler = new MessageHandler(adapter, claude, makeAgent(), null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageHandler — same-thread abort routing', () => {
  it('marks the cancelled run as aborted (NOT done) when a second message preempts it', async () => {
    // Per-call behavior: msg #1 hangs until aborted, msg #2 returns instantly.
    const streamQuery = claude.streamQuery as unknown as ReturnType<typeof vi.fn>;
    let call = 0;
    streamQuery.mockImplementation((_p: unknown, _s: string, ctl?: AbortController) => {
      call++;
      if (call === 1) return hangUntilAborted(ctl);
      // msg #2 yields a success result so it doesn't fall into the
      // "no messages sent → post fallback" branch (a test artifact that
      // would mask the assertion we care about for msg #1).
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: 'second message done' };
      })();
    });

    const inflight = handler.handleMessage(makeMsg('msg-1'));
    // Tick so msg #1 registers its controller and enters the for-await loop.
    await new Promise(r => setTimeout(r, 30));
    const second = handler.handleMessage(makeMsg('msg-2', 'redo'));
    await Promise.all([inflight, second]);

    const reactions = (adapter.postReaction as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map(c => c[2] as string);
    // The fix routes the aborted run through the catch branch (`stop_button`).
    // Without the fix the success branch would mark both as `white_check_mark`.
    expect(reactions).toContain('stop_button');

    // The fix also bypasses the fallback-message branch. Without the throw,
    // an interrupted run with no streamed messages would post the
    // "_No response generated._" fallback into the thread.
    const postedPayloads = (adapter.postPayload as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map(c => (c[1] as { text?: string }).text);
    expect(postedPayloads).not.toContain(FALLBACK_TEXT);
  });

  it('does NOT mark a normally-completing run as aborted', async () => {
    await handler.handleMessage(makeMsg('msg-solo'));

    const reactions = (adapter.postReaction as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map(c => c[2] as string);
    expect(reactions).toContain('white_check_mark');
    expect(reactions).not.toContain('stop_button');

    // Empty stream → success branch posts the fallback (verified to confirm
    // the success branch did run; if abort throw fired spuriously we'd see
    // no fallback and a stop_button instead).
    const postedPayloads = (adapter.postPayload as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map(c => (c[1] as { text?: string }).text);
    expect(postedPayloads).toContain(FALLBACK_TEXT);
  });

  it('keeps the live turn abortable after a preempted turn cleans up (no parallel runs)', async () => {
    // Reproduces the "two turns running in parallel" bug. Three same-session
    // messages arrive in sequence: #1 is preempted by #2, then #3 arrives. The
    // preempted #1's `finally` must NOT delete the controller slot now owned by
    // the still-running #2 — otherwise #3 finds nothing to abort and runs in
    // parallel with #2. We assert #2's controller IS aborted when #3 arrives.
    const streamQuery = claude.streamQuery as unknown as ReturnType<typeof vi.fn>;
    const controllers: AbortController[] = [];
    streamQuery.mockImplementation((_p: unknown, _s: string, ctl?: AbortController) => {
      controllers.push(ctl as AbortController);
      const call = controllers.length;
      if (call === 3) {
        return (async function* () {
          yield { type: 'result', subtype: 'success', result: 'third wins' };
        })();
      }
      // #1 and #2 hang until aborted (or time out so a missed abort can't hang the test).
      return hangUntilAbortedOrTimeout(ctl);
    });

    const first = handler.handleMessage(makeMsg('m1'));
    await new Promise(r => setTimeout(r, 30));   // #1 registers ctrl1, enters loop
    const second = handler.handleMessage(makeMsg('m2', 'again')); // aborts #1, registers ctrl2
    await new Promise(r => setTimeout(r, 30));   // let #1 unwind + run its finally
    const third = handler.handleMessage(makeMsg('m3', 'stop'));   // must abort ctrl2
    await Promise.all([first, second, third]);

    // ctrl2 (the second turn) must have been aborted by the third message.
    // Without the identity guard, #1's finally deletes ctrl2 from the slot, so
    // #3's `get(sessionKey)?.abort()` is a no-op and ctrl2 stays unaborted.
    expect(controllers).toHaveLength(3);
    expect(controllers[1].signal.aborted).toBe(true);
  });

  it('routes to the abort branch when signal flips between loop end and post-loop check', async () => {
    // Race-edge guard: streamQuery returns normally, then before the
    // post-loop `if (signal.aborted)` check runs, an external abort fires.
    // Simulated by aborting the captured controller from inside streamQuery
    // immediately before returning — the loop ends with no AbortError, but
    // signal.aborted is true. The fix's throw must catch this; without it,
    // the success path would silently mark the cancelled run as `done`.
    (claude.streamQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // eslint-disable-next-line require-yield
      async function* (_p: unknown, _s: string, ctl?: AbortController) {
        ctl?.abort(); // late abort; generator returns cleanly (no throw)
        return;
      },
    );

    await handler.handleMessage(makeMsg('msg-late-abort'));

    const reactions = (adapter.postReaction as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map(c => c[2] as string);
    expect(reactions).toContain('stop_button');
    expect(reactions).not.toContain('white_check_mark');
  });
});
