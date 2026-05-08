/**
 * @fileoverview Regression tests for verbose-mode posting.
 *
 * The bug: modern Claude SDK / Sonnet 4.6 emits reasoning prose as `thinking`
 * blocks instead of `text` blocks (when ThinkingConfig is `adaptive`, the
 * default). The verbose path filtered only `type === 'text'` so it silently
 * stopped showing intermediate prose ~7 days ago. Fix surfaces thinking
 * content (italicized) in verbose mode while keeping `lastAssistantText`
 * (the non-verbose fallback) populated only from real text blocks.
 *
 * @module runner/__tests__/message-handler-verbose
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, IncomingMessage, PlatformAdapter } from '@slackhive/shared';
import { MessageHandler } from '../message-handler';
import type { ClaudeHandler } from '../claude-handler';

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
 * Fake ClaudeHandler whose streamQuery yields a caller-supplied list of
 * SDK messages and then returns. Lets each test control exactly what
 * content blocks reach the message handler.
 */
function makeClaudeHandlerYielding(messages: unknown[]): ClaudeHandler {
  return {
    getSessionKey: (userId: string, channelId: string, threadTs?: string) =>
      `${userId}-${channelId}-${threadTs ?? 'direct'}`,
    streamQuery: vi.fn(async function* () {
      for (const m of messages) yield m as never;
    }),
  } as unknown as ClaudeHandler;
}

function makeAgent(verbose: boolean): Agent {
  return {
    id: 'agent-test',
    slug: 'verbose-test',
    name: 'VerboseTest',
    persona: null,
    description: null,
    model: 'claude-sonnet-4-6',
    status: 'running',
    enabled: true,
    isBoss: false,
    verbose,
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

function makeMsg(): IncomingMessage {
  return {
    id: 'msg-1',
    platform: 'test', // bypass user access check
    userId: 'U_test',
    channelId: 'C_test',
    threadId: 't_thread',
    text: 'do the thing',
    isDM: false,
    raw: {},
  } as unknown as IncomingMessage;
}

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(() => {
  adapter = makeAdapter();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function postedTexts(): string[] {
  return (adapter.postPayload as unknown as ReturnType<typeof vi.fn>)
    .mock.calls.map(c => (c[1] as { text?: string }).text ?? '');
}

describe('MessageHandler — verbose surfaces thinking blocks', () => {
  it('posts italicized thinking text alongside tool_use in verbose mode', async () => {
    // Simulates modern Sonnet: assistant message with a thinking block + a
    // tool_use, no separate text block. Pre-fix this would have posted
    // nothing (textContent empty); post-fix posts the italicized thinking.
    const claude = makeClaudeHandlerYielding([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me check the database first.' },
            { type: 'tool_use', id: 'tool-1', name: 'redshift-query', input: { sql: 'SELECT 1' } },
          ],
        },
      },
      // Final answer arrives as a result message (no tool_use)
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '12 rows.' }] },
      },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(true), null);
    await handler.handleMessage(makeMsg());

    const posts = postedTexts();
    expect(posts).toContain('_Let me check the database first._');
    expect(posts).toContain('12 rows.');
  });

  it('posts both thinking and text when both arrive in the same assistant message', async () => {
    // Some models still emit a text block alongside thinking. Both should
    // appear: thinking first (italicized), then text (plain), separated by
    // a blank line.
    const claude = makeClaudeHandlerYielding([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Reasoning here.' },
            { type: 'text', text: 'Working on it.' },
            { type: 'tool_use', id: 't-1', name: 'Read', input: { path: 'README.md' } },
          ],
        },
      },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(true), null);
    await handler.handleMessage(makeMsg());

    const posts = postedTexts();
    expect(posts.some(p => p.includes('_Reasoning here._') && p.includes('Working on it.'))).toBe(true);
  });

  it('does NOT post intermediate thinking when verbose is OFF', async () => {
    const claude = makeClaudeHandlerYielding([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Some private reasoning.' },
            { type: 'tool_use', id: 't-1', name: 'Read', input: { path: 'a' } },
          ],
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Final answer.' }] },
      },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(false), null);
    await handler.handleMessage(makeMsg());

    const posts = postedTexts();
    // Thinking must NOT leak when verbose is off.
    expect(posts.every(p => !p.includes('Some private reasoning'))).toBe(true);
    // Final answer still comes through (non-verbose path uses lastAssistantText
    // fallback or the final assistant text directly).
    expect(posts).toContain('Final answer.');
  });

  it('skips thinking-only messages when verbose is OFF (regression: do not crash on no text)', async () => {
    // Pre-fix the `else if (textContent)` branch was the only text-only
    // path. With thinking-only messages and verbose off, no post happens
    // (correct) but the handler must not throw or break the for-await loop.
    const claude = makeClaudeHandlerYielding([
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'just thinking' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
    ]);
    const handler = new MessageHandler(adapter, claude, makeAgent(false), null);
    await expect(handler.handleMessage(makeMsg())).resolves.toBeUndefined();
    const posts = postedTexts();
    expect(posts).toContain('done');
  });
});
