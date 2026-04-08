/**
 * @fileoverview Unit tests for thread context building in slack-handler.ts.
 *
 * Covers:
 * - Real usernames and IDs resolved via users.info
 * - Bot messages labeled with agent name
 * - Forwarded message attachments (text, pretext, image_url, source)
 * - Files shared in thread history (images, other files)
 * - Username resolution cached across messages (single API call per user)
 * - users.info failure falls back to user ID
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPrompt } from '../slack-handler';
import type { Logger } from 'winston';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const fakeAgent = {
  id: 'agent-1',
  name: 'Gilfoyle',
  slackBotUserId: 'UBOT001',
} as any;

function makeClient(messages: any[], userMap: Record<string, { display_name?: string; real_name?: string }> = {}) {
  return {
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages }),
    },
    users: {
      info: vi.fn().mockImplementation(({ user }: { user: string }) => {
        const u = userMap[user];
        if (!u) return Promise.reject(new Error('user not found'));
        return Promise.resolve({ user: u });
      }),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildPrompt — thread context', () => {
  it('resolves display names and user IDs for human messages', async () => {
    const messages = [
      { user: 'U001', text: 'hello there', ts: '1.0' },
      { user: 'U002', text: 'hey @Gilfoyle', ts: '2.0' },
      { user: 'U002', text: 'current message', ts: '3.0' }, // last message excluded
    ];
    const client = makeClient(messages, {
      U001: { display_name: 'Aman' },
      U002: { display_name: 'Kush' },
    });

    const result = await buildPrompt(client, 'C001', '1.0', 'current message', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).toContain('Aman (U001): hello there');
    expect(text).toContain('Kush (U002): hey');
  });

  it('labels bot messages with agent name', async () => {
    const messages = [
      { bot_id: 'B001', text: 'I am a bot response', ts: '1.0' },
      { user: 'U001', text: 'follow up', ts: '2.0' }, // last excluded
    ];
    const client = makeClient(messages, {});

    const result = await buildPrompt(client, 'C001', '1.0', 'follow up', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).toContain('Gilfoyle: I am a bot response');
    expect(text).not.toContain('User:');
  });

  it('falls back to user ID when users.info fails', async () => {
    const messages = [
      { user: 'U999', text: 'mystery message', ts: '1.0' },
      { user: 'U001', text: 'next', ts: '2.0' }, // last excluded
    ];
    const client = makeClient(messages, {}); // U999 not in map → throws

    const result = await buildPrompt(client, 'C001', '1.0', 'next', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).toContain('U999: mystery message');
  });

  it('only calls users.info for unique users across the thread', async () => {
    const messages = [
      { user: 'U001', text: 'first message', ts: '1.0' },
      { user: 'U002', text: 'second message', ts: '2.0' },
      { user: 'U001', text: 'current', ts: '3.0' }, // last excluded
    ];
    const client = makeClient(messages, {
      U001: { display_name: 'Aman' },
      U002: { display_name: 'Kush' },
    });

    const result = await buildPrompt(client, 'C001', '1.0', 'current', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    // Both users resolved correctly
    expect(text).toContain('Aman (U001): first message');
    expect(text).toContain('Kush (U002): second message');
    // Only 2 unique users → max 2 API calls
    expect(client.users.info).toHaveBeenCalledTimes(2);
  });

  it('includes forwarded message attachment text and source', async () => {
    const messages = [
      {
        user: 'U001', text: 'check this out', ts: '1.0',
        attachments: [{
          author_name: 'Kush',
          text: 'why you need to be hi/hello?',
          pretext: 'Forwarded message:',
        }],
      },
      { user: 'U001', text: 'current', ts: '2.0' }, // last excluded
    ];
    const client = makeClient(messages, { U001: { display_name: 'Aman' } });

    const result = await buildPrompt(client, 'C001', '1.0', 'current', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).toContain('check this out');
    expect(text).toContain('[Forwarded from Kush]');
    expect(text).toContain('Forwarded message:');
    expect(text).toContain('why you need to be hi/hello?');
  });

  it('includes image_url from forwarded attachments', async () => {
    const messages = [
      {
        user: 'U001', text: 'see screenshot', ts: '1.0',
        attachments: [{
          text: 'look at this',
          image_url: 'https://files.slack.com/screenshot.png',
        }],
      },
      { user: 'U001', text: 'current', ts: '2.0' },
    ];
    const client = makeClient(messages, { U001: { display_name: 'Aman' } });

    const result = await buildPrompt(client, 'C001', '1.0', 'current', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).toContain('[Attached image: https://files.slack.com/screenshot.png]');
  });

  it('uses fallback text when attachment has no text', async () => {
    const messages = [
      {
        user: 'U001', text: 'fwd', ts: '1.0',
        attachments: [{ fallback: 'fallback content here' }],
      },
      { user: 'U001', text: 'current', ts: '2.0' },
    ];
    const client = makeClient(messages, { U001: { display_name: 'Aman' } });

    const result = await buildPrompt(client, 'C001', '1.0', 'current', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).toContain('fallback content here');
  });

  it('notes images shared in thread history', async () => {
    const messages = [
      {
        user: 'U001', text: '', ts: '1.0',
        files: [{ id: 'F001', name: 'screenshot.png', mimetype: 'image/png' }],
      },
      { user: 'U001', text: 'current', ts: '2.0' },
    ];
    const client = makeClient(messages, { U001: { display_name: 'Aman' } });

    const result = await buildPrompt(client, 'C001', '1.0', 'current', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).toContain('[Shared image: screenshot.png]');
  });

  it('notes non-image files shared in thread history', async () => {
    const messages = [
      {
        user: 'U001', text: '', ts: '1.0',
        files: [{ id: 'F002', name: 'report.csv', mimetype: 'text/csv' }],
      },
      { user: 'U001', text: 'current', ts: '2.0' },
    ];
    const client = makeClient(messages, { U001: { display_name: 'Aman' } });

    const result = await buildPrompt(client, 'C001', '1.0', 'current', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).toContain('[Shared file: report.csv]');
  });

  it('returns no thread context when threadTs is undefined', async () => {
    const client = makeClient([]);

    const result = await buildPrompt(client, 'C001', undefined, 'hello', fakeAgent, nopLog);
    const text = typeof result === 'string' ? result : '';

    expect(text).not.toContain('[Thread context]');
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });
});
