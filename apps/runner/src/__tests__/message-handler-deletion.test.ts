import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentBackend, IncomingMessage, PlatformAdapter } from '@slackhive/shared';
import { MessageHandler } from '../message-handler';

const NOTICE = '⛔ Request cancelled because the original message was deleted.';

function makeAdapter(): PlatformAdapter {
  return {
    platform: 'test',
    postMessage: vi.fn(async () => 'notice-ts'),
    postPayload: vi.fn(async () => 'reply-ts'),
    updateMessage: vi.fn(async () => undefined),
    postReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => []),
    getUserDisplayName: vi.fn(async () => 'tester'),
    downloadFile: vi.fn(async () => Buffer.alloc(0)),
    buildPayloads: vi.fn((text: string) => [{ text }]),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as PlatformAdapter;
}

function makeBackend(): AgentBackend {
  return {
    backend: 'claude',
    getSessionKey: (userId: string, channelId: string, threadId?: string) =>
      `${userId}:${channelId}:${threadId ?? 'direct'}`,
    streamQuery: vi.fn(async function* (_prompt: string, _sessionKey: string, ctl?: AbortController) {
      while (!ctl?.signal.aborted) await new Promise(resolve => setTimeout(resolve, 5));
    }),
  } as unknown as AgentBackend;
}

function makeAgent(): Agent {
  return {
    id: 'agent-test', slug: 'test-agent', name: 'Test', model: 'claude-opus-4-7',
    status: 'running', enabled: true, isBoss: false, verbose: false, reportsTo: [],
    tags: [], claudeMd: '', createdBy: 'system', createdAt: new Date(), updatedAt: new Date(),
  } as unknown as Agent;
}

function makeMessage(id = '123.456'): IncomingMessage {
  return {
    id,
    platform: 'test',
    userId: 'U1',
    channelId: 'C1',
    threadId: id,
    text: 'question',
    isDM: false,
    raw: {},
  };
}

describe('MessageHandler source-message deletion', () => {
  let adapter: PlatformAdapter;
  let backend: AgentBackend;
  let handler: MessageHandler;

  beforeEach(() => {
    adapter = makeAdapter();
    backend = makeBackend();
    handler = new MessageHandler(adapter, backend, makeAgent(), null);
  });

  it('aborts the matching run and posts one non-threaded cancellation notice', async () => {
    const inflight = handler.handleMessage(makeMessage());
    await new Promise(resolve => setTimeout(resolve, 20));
    const reactionCallsBeforeDeletion = vi.mocked(adapter.postReaction).mock.calls.length;

    const cancelled = await handler.cancelByDeletedMessage('C1', '123.456');
    await inflight;

    expect(cancelled).toBe(true);
    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledWith('C1', NOTICE);
    expect(adapter.postPayload).not.toHaveBeenCalled();
    expect(vi.mocked(adapter.postReaction).mock.calls).toHaveLength(reactionCallsBeforeDeletion);
  });

  it('ignores unrelated and repeated deletion events', async () => {
    const inflight = handler.handleMessage(makeMessage());
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(await handler.cancelByDeletedMessage('C1', 'unrelated')).toBe(false);
    expect(adapter.postMessage).not.toHaveBeenCalled();

    expect(await handler.cancelByDeletedMessage('C1', '123.456')).toBe(true);
    expect(await handler.cancelByDeletedMessage('C1', '123.456')).toBe(false);
    await inflight;

    expect(adapter.postMessage).toHaveBeenCalledOnce();
  });

  it('honors a deletion that arrives just before the run is registered', async () => {
    expect(await handler.cancelByDeletedMessage('C1', '123.456')).toBe(false);

    await handler.handleMessage(makeMessage());

    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledWith('C1', NOTICE);
    expect(backend.streamQuery).not.toHaveBeenCalled();
    expect(adapter.postReaction).not.toHaveBeenCalled();
  });

  it('stops a split response between Slack payloads', async () => {
    vi.mocked(backend.streamQuery).mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'split answer' } as any;
    });
    vi.mocked(adapter.buildPayloads).mockReturnValue([{ text: 'part 1' }, { text: 'part 2' }]);
    vi.mocked(adapter.postPayload).mockImplementationOnce(async () => {
      await handler.cancelByDeletedMessage('C1', '123.456');
      return 'part-1-ts';
    });

    await handler.handleMessage(makeMessage());

    expect(adapter.postPayload).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledWith('C1', NOTICE);
  });
});
