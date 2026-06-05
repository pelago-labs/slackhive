/**
 * @fileoverview Tests for inline feedback-control attachment.
 *
 * Feedback buttons attach to the agent's FINAL reply (no separate message): the
 * handler calls adapter.attachFeedbackControls(channel, lastReplyTs, payload, …)
 * after a successful, human-initiated turn. These tests pin that wiring:
 *   - it targets the LAST posted message and passes the payload it was posted
 *     with (so the adapter can later rebuild the message without wiping it),
 *   - it is skipped for bot/agent traffic, and
 *   - it is skipped when no real answer was posted (placeholder fallback only).
 *
 * @module runner/__tests__/message-handler-feedback
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, IncomingMessage, PlatformAdapter } from '@slackhive/shared';
import { MessageHandler } from '../message-handler';
import type { ClaudeHandler } from '../claude-handler';

function makeAdapter(): PlatformAdapter {
  let n = 0;
  return {
    platform: 'test',
    formattingRules: '',
    postMessage: vi.fn(async () => 'msg-id'),
    // Distinct id per post so we can assert which one feedback attached to.
    postPayload: vi.fn(async () => `msg-${++n}`),
    updateMessage: vi.fn(async () => undefined),
    postReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => []),
    getUserDisplayName: vi.fn(async () => 'tester'),
    downloadFile: vi.fn(async () => null),
    resolveLinkedMessage: vi.fn(async () => null),
    buildPayloads: vi.fn((text: string) => [{ text }]),
    attachFeedbackControls: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as PlatformAdapter;
}

function makeClaudeHandlerYielding(messages: unknown[]): ClaudeHandler {
  return {
    getSessionKey: (userId: string, channelId: string, threadTs?: string) =>
      `${userId}-${channelId}-${threadTs ?? 'direct'}`,
    streamQuery: vi.fn(async function* () {
      for (const m of messages) yield m as never;
    }),
  } as unknown as ClaudeHandler;
}

function makeAgent(verbose = false): Agent {
  return {
    id: 'agent-test', slug: 'fb-test', name: 'FbTest', persona: null, description: null,
    model: 'claude-sonnet-4-6', status: 'running', enabled: true, isBoss: false, verbose,
    reportsTo: [], tags: [], claudeMd: '', createdBy: 'system', createdAt: new Date(), updatedAt: new Date(),
    slackBotToken: '', slackAppToken: '', slackSigningSecret: '',
  } as unknown as Agent;
}

function makeMsg(raw: unknown = {}): IncomingMessage {
  return {
    id: 'msg-1', platform: 'test', userId: 'U_test', channelId: 'C_test',
    threadId: 't_thread', text: 'do the thing', isDM: false, raw,
  } as unknown as IncomingMessage;
}

let adapter: ReturnType<typeof makeAdapter>;
beforeEach(() => { adapter = makeAdapter(); });
afterEach(() => { vi.restoreAllMocks(); });

const attachMock = () => adapter.attachFeedbackControls as unknown as ReturnType<typeof vi.fn>;

describe('MessageHandler — inline feedback attachment', () => {
  it('attaches feedback to the LAST reply, passing its id, payload, and thread', async () => {
    const claude = makeClaudeHandlerYielding([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'the answer' }] } },
      { type: 'result', subtype: 'success', result: 'the answer' },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(), null);
    await handler.handleMessage(makeMsg());

    expect(attachMock()).toHaveBeenCalledTimes(1);
    const [channel, messageId, payload, threadId] = attachMock().mock.calls[0];
    expect(channel).toBe('C_test');
    // The only answer post returned 'msg-1' (first postPayload call).
    expect(messageId).toBe('msg-1');
    expect(payload).toEqual({ text: 'the answer' });
    expect(threadId).toBe('t_thread');
  });

  it('targets the final reply when several messages were posted', async () => {
    // buildPayloads splits this answer into two payloads → two postPayload calls.
    (adapter.buildPayloads as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (text: string) => [{ text: `${text} (1/2)` }, { text: `${text} (2/2)` }],
    );
    const claude = makeClaudeHandlerYielding([
      { type: 'result', subtype: 'success', result: 'long answer' },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(), null);
    await handler.handleMessage(makeMsg());

    expect(attachMock()).toHaveBeenCalledTimes(1);
    const [, messageId, payload] = attachMock().mock.calls[0];
    // Second (last) postPayload returned 'msg-2'; feedback attaches there.
    expect(messageId).toBe('msg-2');
    expect(payload).toEqual({ text: 'long answer (2/2)' });
  });

  it('does NOT attach feedback to bot / agent-delegation traffic', async () => {
    const claude = makeClaudeHandlerYielding([
      { type: 'result', subtype: 'success', result: 'the answer' },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(), null);
    await handler.handleMessage(makeMsg({ bot_id: 'B123' }));

    expect(attachMock()).not.toHaveBeenCalled();
  });

  it('attaches to the ANSWER, not a trailing thinking-only post (verbose mode)', async () => {
    // Verbose streams: [thinking + answer] then [thinking only]. Feedback must
    // land on the answer-bearing message (msg-1), not the trailing reasoning post.
    const claude = makeClaudeHandlerYielding([
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'the answer' }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'more reasoning' }] } },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(true), null);
    await handler.handleMessage(makeMsg());

    expect(attachMock()).toHaveBeenCalledTimes(1);
    const [, messageId, payload] = attachMock().mock.calls[0];
    expect(messageId).toBe('msg-1'); // the post that carried the answer text
    expect((payload as { text: string }).text).toContain('the answer');
  });

  it('does NOT attach feedback when only the empty placeholder was posted', async () => {
    // No assistant text and no tool result → the "_No response generated._"
    // placeholder is posted but never counts as a real answer.
    const claude = makeClaudeHandlerYielding([
      { type: 'result', subtype: 'success', result: '' },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(), null);
    await handler.handleMessage(makeMsg());

    expect(attachMock()).not.toHaveBeenCalled();
  });
});
