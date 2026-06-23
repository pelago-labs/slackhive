/**
 * @fileoverview Duplicate-delivery dedup. Slack delivers events at-least-once, and a
 * boss agent re-mentioning a reportee in a multi-part reply arrives as a second
 * identical event ~1s later. Both hit the same sessionKey and the second would abort
 * the turn started by the first (a spurious "Operation aborted"). handleMessage drops
 * an identical message for the same session within a short window.
 *
 * @module runner/__tests__/message-handler-dedup
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, IncomingMessage, PlatformAdapter } from '@slackhive/shared';
import { MessageHandler } from '../message-handler';

function makeAdapter(): PlatformAdapter {
  return {
    platform: 'test',
    formattingRules: '',
    postMessage: vi.fn(async () => 'm'),
    postPayload: vi.fn(async () => 'm'),
    updateMessage: vi.fn(async () => undefined),
    postReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => []),
    getUserDisplayName: vi.fn(async () => 'tester'),
    downloadFile: vi.fn(async () => null),
    resolveLinkedMessage: vi.fn(async () => null),
    buildPayloads: vi.fn((t: string) => [{ text: t }]),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as PlatformAdapter;
}

function makeBackend() {
  return {
    getSessionKey: (u: string, c: string, t?: string) => `${u}-${c}-${t ?? 'direct'}`,
    getSessionWorkDir: () => '/tmp',
    streamQuery: vi.fn(async function* () { /* yields nothing */ }),
  };
}

function makeAgent(): Agent {
  return {
    id: 'a', slug: 'dedup-test', name: 'Dedup', persona: null, description: null,
    model: 'claude-sonnet-4-6', status: 'running', enabled: true, isBoss: false,
    verbose: false, reportsTo: [], tags: [], claudeMd: '', createdBy: 'system',
    createdAt: new Date(), updatedAt: new Date(),
    slackBotToken: '', slackAppToken: '', slackSigningSecret: '',
  } as unknown as Agent;
}

function makeMsg(text: string, id = 'm1'): IncomingMessage {
  return { id, platform: 'test', userId: 'Uboss', channelId: 'C1', threadId: 't1', text, isDM: false, raw: {} } as unknown as IncomingMessage;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('MessageHandler — duplicate-delivery dedup', () => {
  it('drops a duplicate identical message for the same session (only one turn runs)', async () => {
    const backend = makeBackend();
    const handler = new MessageHandler(makeAdapter(), backend as never, makeAgent(), null);
    await handler.handleMessage(makeMsg('how does productUnitsData handle FSP?'));
    await handler.handleMessage(makeMsg('how does productUnitsData handle FSP?')); // boss re-mention / Slack redelivery
    expect((backend.streamQuery as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('still processes two genuinely different messages', async () => {
    const backend = makeBackend();
    const handler = new MessageHandler(makeAdapter(), backend as never, makeAgent(), null);
    await handler.handleMessage(makeMsg('first question', 'm1'));
    await handler.handleMessage(makeMsg('second question', 'm2')); // distinct Slack ts
    expect((backend.streamQuery as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('does not cross-dedup identical text from different senders', async () => {
    const backend = makeBackend();
    const handler = new MessageHandler(makeAdapter(), backend as never, makeAgent(), null);
    const base = makeMsg('same words');
    await handler.handleMessage(base);
    await handler.handleMessage({ ...base, userId: 'Uother' } as IncomingMessage); // different sender → different session
    expect((backend.streamQuery as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('does NOT dedup a replay even when it reuses the original message id', async () => {
    // replayActivity re-feeds the original message id with raw.replay=true. Without the
    // exemption, a replay of a just-failed turn collides with the original's still-live
    // dedup entry and is silently dropped while the route reports success.
    const backend = makeBackend();
    const handler = new MessageHandler(makeAdapter(), backend as never, makeAgent(), null);
    await handler.handleMessage(makeMsg('analyse this', 'm1')); // original delivery
    const replay = { ...makeMsg('analyse this', 'm1'), raw: { replay: true } } as unknown as IncomingMessage;
    await handler.handleMessage(replay); // same id, within window — must still run
    expect((backend.streamQuery as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});
