import { beforeEach, describe, expect, it, vi } from 'vitest';

const bolt = vi.hoisted(() => {
  const messageHandlers: Array<{ matcher?: unknown; handler: (args: unknown) => Promise<void> }> = [];
  const app = {
    client: {},
    event: vi.fn(),
    message: vi.fn((matcherOrHandler: unknown, maybeHandler?: (args: unknown) => Promise<void>) => {
      if (maybeHandler) messageHandlers.push({ matcher: matcherOrHandler, handler: maybeHandler });
      else messageHandlers.push({ handler: matcherOrHandler as (args: unknown) => Promise<void> });
    }),
    action: vi.fn(),
    view: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  return { app, messageHandlers };
});

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    constructor() { return bolt.app; }
  },
  LogLevel: { DEBUG: 'debug', WARN: 'warn' },
  subtype: (value: string) => Object.assign(vi.fn(), { subtype: value }),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class MockWebClient {
    auth = { test: vi.fn(async () => ({ user_id: 'UBOT' })) };
  },
}));

import { SlackAdapter } from '../adapters/slack-adapter';

describe('SlackAdapter message deletion events', () => {
  beforeEach(() => {
    bolt.messageHandlers.length = 0;
    vi.clearAllMocks();
  });

  it('normalizes channel and deleted timestamp for the registered handler', async () => {
    const adapter = new SlackAdapter(
      { platform: 'slack', botToken: 'x', appToken: 'y', signingSecret: 'z' },
      'test-agent',
    );
    const deleted = vi.fn(async () => undefined);

    adapter.onMessageDeleted(deleted);
    await adapter.start();

    const registration = bolt.messageHandlers.find(
      ({ matcher }) => (matcher as { subtype?: string } | undefined)?.subtype === 'message_deleted',
    );
    expect(registration).toBeDefined();

    await registration!.handler({
      message: { subtype: 'message_deleted', channel: 'C1', deleted_ts: '123.456' },
    });

    expect(deleted).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledWith({ channelId: 'C1', messageId: '123.456' });
  });
});
