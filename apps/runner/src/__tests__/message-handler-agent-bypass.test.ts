/**
 * @fileoverview Regression tests for the agent-traffic bypass on the user
 * access check in MessageHandler.
 *
 * The bug: when a boss agent @-mentions a specialist in Slack, the
 * specialist's `userCanTrigger(userId)` check at message-handler.ts:86
 * evaluates the boss's bot user ID against the per-user access grants —
 * which the boss never has — and the specialist replies "You don't have
 * access to this agent." Boss → specialist delegation is broken.
 *
 * Fix: when `raw.bot_id` or `raw.app_id` is set (Slack adapter forwards
 * both for bot-posted messages), bypass the user access check. The boss
 * bot's authorization to invoke this specialist is enforced upstream by
 * the boss registry; the per-user grant check would always deny.
 *
 * @module runner/__tests__/message-handler-agent-bypass
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, IncomingMessage, PlatformAdapter } from '@slackhive/shared';
import { MessageHandler } from '../message-handler';
import type { ClaudeHandler } from '../claude-handler';

const DENIAL_TEXT = "You don't have access to this agent.";

function makeAdapter(): PlatformAdapter {
  return {
    platform: 'slack',
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

function makeClaudeHandler(): ClaudeHandler {
  return {
    getSessionKey: (userId: string, channelId: string, threadTs?: string) =>
      `${userId}-${channelId}-${threadTs ?? 'direct'}`,
    // eslint-disable-next-line require-yield
    streamQuery: vi.fn(async function* () { return; }),
  } as unknown as ClaudeHandler;
}

function makeAgent(): Agent {
  return {
    id: 'agent-specialist',
    slug: 'specialist',
    name: 'Specialist',
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

function makeMsg(opts: { bot_id?: string; app_id?: string }): IncomingMessage {
  return {
    id: 'msg-1',
    platform: 'slack', // NOT 'test' — we want the access check to actually run
    userId: 'B0BOSS',  // a bot user id with no human-grant
    channelId: 'C_chan',
    threadId: 't_thread',
    text: 'please do the thing',
    isDM: false,
    raw: {
      client: {},
      messageTs: 'msg-1',
      ...(opts.bot_id ? { bot_id: opts.bot_id } : {}),
      ...(opts.app_id ? { app_id: opts.app_id } : {}),
    },
  } as unknown as IncomingMessage;
}

let handler: MessageHandler;
let adapter: ReturnType<typeof makeAdapter>;
let claude: ReturnType<typeof makeClaudeHandler>;

beforeEach(() => {
  adapter = makeAdapter();
  claude = makeClaudeHandler();
  handler = new MessageHandler(adapter, claude, makeAgent(), null);
  // Force userCanTrigger to deny so we're sure the bypass is what lets the
  // agent-traffic case through (and lack of bypass is what blocks humans).
  vi.spyOn(handler as unknown as { userCanTrigger: () => Promise<boolean> }, 'userCanTrigger')
    .mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageHandler — agent traffic bypass on access check', () => {
  it('bypasses userCanTrigger when raw.bot_id is set (boss → specialist)', async () => {
    await handler.handleMessage(makeMsg({ bot_id: 'B0BOSS' }));

    // Bypass kicked in — message processed past the gate; no denial posted.
    const posts = (adapter.postMessage as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map(c => c[1] as string);
    expect(posts).not.toContain(DENIAL_TEXT);

    // streamQuery was called → handler proceeded into the actual stream path.
    expect(claude.streamQuery as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('bypasses userCanTrigger when only raw.app_id is set', async () => {
    await handler.handleMessage(makeMsg({ app_id: 'A0BOSS' }));
    const posts = (adapter.postMessage as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map(c => c[1] as string);
    expect(posts).not.toContain(DENIAL_TEXT);
    expect(claude.streamQuery as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('still denies real human users with no access grant (no bot_id / app_id)', async () => {
    await handler.handleMessage(makeMsg({}));

    // Denial posted, streamQuery never invoked.
    const posts = (adapter.postMessage as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map(c => c[1] as string);
    expect(posts).toContain(DENIAL_TEXT);
    expect(claude.streamQuery as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
