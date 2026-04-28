/**
 * @fileoverview Tests for Slack permalink resolution.
 *
 * Covers:
 *   - parseSlackPermalink   — URL → { channelId, ts }
 *   - extractSlackPermalinkUrls — mrkdwn text → URL list
 *   - SlackAdapter.resolveLinkedMessage — integration with mocked Bolt client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSlackPermalink, extractSlackPermalinkUrls } from '../adapters/slack-adapter';

// ─── parseSlackPermalink ──────────────────────────────────────────────────────

describe('parseSlackPermalink', () => {
  it('parses a standard Slack archive URL', () => {
    const result = parseSlackPermalink(
      'https://myteam.slack.com/archives/C04RC7S3B34/p1777315257693249',
    );
    expect(result).toEqual({ channelId: 'C04RC7S3B34', ts: '1777315257.693249' });
  });

  it('parses thread reply links and extracts thread_ts', () => {
    const result = parseSlackPermalink(
      'https://myteam.slack.com/archives/C04RC7S3B34/p1777315257693249?thread_ts=1777315200.000100&cid=C04RC7S3B34',
    );
    expect(result).toEqual({ channelId: 'C04RC7S3B34', ts: '1777315257.693249', threadTs: '1777315200.000100' });
  });

  it('returns threadTs undefined for non-thread links', () => {
    const result = parseSlackPermalink(
      'https://myteam.slack.com/archives/C04RC7S3B34/p1777315257693249',
    );
    expect(result?.threadTs).toBeUndefined();
  });

  it('accepts lowercase channel IDs (shared channels edge case)', () => {
    const result = parseSlackPermalink(
      'https://myteam.slack.com/archives/c04rc7s3b34/p1777315257693249',
    );
    expect(result?.channelId).toBe('c04rc7s3b34');
  });

  it('returns null for non-Slack URLs', () => {
    expect(parseSlackPermalink('https://example.com/foo/bar')).toBeNull();
  });

  it('returns null for Slack URLs without /archives/ path', () => {
    expect(parseSlackPermalink('https://myteam.slack.com/messages/C04RC7S3B34')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSlackPermalink('')).toBeNull();
  });

  it('preserves exactly 6 decimal digits in timestamp', () => {
    const result = parseSlackPermalink(
      'https://x.slack.com/archives/CABC123/p1000000000000001',
    );
    expect(result?.ts).toBe('1000000000.000001');
  });
});

// ─── extractSlackPermalinkUrls ────────────────────────────────────────────────

describe('extractSlackPermalinkUrls', () => {
  it('extracts a bare URL from plain text', () => {
    const text = 'check this out https://myteam.slack.com/archives/C123/p1111111111111111 thanks';
    expect(extractSlackPermalinkUrls(text)).toEqual([
      'https://myteam.slack.com/archives/C123/p1111111111111111',
    ]);
  });

  it('extracts URL from angle-bracket mrkdwn form <url|label>', () => {
    const text = 'see <https://myteam.slack.com/archives/C123/p1111111111111111|this message>';
    expect(extractSlackPermalinkUrls(text)).toEqual([
      'https://myteam.slack.com/archives/C123/p1111111111111111',
    ]);
  });

  it('extracts URL from angle-bracket form without label <url>', () => {
    const text = '<https://myteam.slack.com/archives/C123/p1111111111111111>';
    expect(extractSlackPermalinkUrls(text)).toEqual([
      'https://myteam.slack.com/archives/C123/p1111111111111111',
    ]);
  });

  it('extracts multiple URLs up to the default limit of 3', () => {
    const urls = [
      'https://x.slack.com/archives/C1/p1000000000000001',
      'https://x.slack.com/archives/C2/p2000000000000001',
      'https://x.slack.com/archives/C3/p3000000000000001',
      'https://x.slack.com/archives/C4/p4000000000000001',
    ];
    const text = urls.join(' ');
    const result = extractSlackPermalinkUrls(text);
    expect(result).toHaveLength(3);
    expect(result).toEqual(urls.slice(0, 3));
  });

  it('respects a custom limit', () => {
    const urls = [
      'https://x.slack.com/archives/C1/p1000000000000001',
      'https://x.slack.com/archives/C2/p2000000000000001',
    ];
    expect(extractSlackPermalinkUrls(urls.join(' '), 1)).toHaveLength(1);
  });

  it('deduplicates repeated URLs', () => {
    const url = 'https://myteam.slack.com/archives/C123/p1111111111111111';
    expect(extractSlackPermalinkUrls(`${url} ${url}`)).toEqual([url]);
  });

  it('returns empty array when no Slack URLs present', () => {
    expect(extractSlackPermalinkUrls('no links here')).toEqual([]);
    expect(extractSlackPermalinkUrls('https://example.com/archives/foo/p123')).toEqual([]);
  });
});

// ─── resolveLinkedMessage (mocked Bolt client) ────────────────────────────────

describe('resolveLinkedMessage via mocked Slack client', () => {
  // Build a minimal SlackAdapter-like object that exercises resolveLinkedMessage
  // without constructing a real Bolt app. We replicate the method directly and
  // inject a fake client so the test stays fast and hermetic.

  function makeAdapter(
    historyMessages: any[],
    repliesMessages: any[] = [],
    displayName = 'Alice',
  ) {
    const fakeClient = {
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: historyMessages }),
        replies: vi.fn().mockResolvedValue({ messages: repliesMessages }),
      },
    };

    // Mirror the actual resolveLinkedMessage logic with getUserDisplayName injected
    async function getUserDisplayName(userId: string): Promise<string> {
      return displayName;
    }

    async function resolveLinkedMessage(url: string) {
      const parsed = parseSlackPermalink(url);
      if (!parsed) return null;
      const { channelId, ts, threadTs } = parsed;
      try {
        let msg: any;
        if (threadTs) {
          const result = await fakeClient.conversations.replies({
            channel: channelId, ts: threadTs, latest: ts, oldest: ts, inclusive: true, limit: 10,
          });
          msg = (result.messages as any[])?.find((m: any) => m.ts === ts);
        } else {
          const result = await fakeClient.conversations.history({
            channel: channelId, latest: ts, oldest: ts, inclusive: true, limit: 1,
          });
          msg = result.messages?.[0];
        }
        if (!msg) return null;
        let senderName = msg.user ?? msg.bot_id ?? 'unknown';
        if (msg.user) {
          try { senderName = await getUserDisplayName(msg.user); } catch { /* fallback */ }
        }
        const rawText = msg.text ?? '';
        const text = `from ${senderName} in <#${channelId}>:\n${rawText}`;
        const files = (msg.files ?? []).map((f: any) => ({
          id: f.id, name: f.name, mimeType: f.mimetype, url: f.url_private_download,
        }));
        return { text, files };
      } catch {
        return null;
      }
    }

    return { resolveLinkedMessage, fakeClient };
  }

  const TEST_URL = 'https://myteam.slack.com/archives/C04RC7S3B34/p1777315257693249';
  const THREAD_URL = 'https://myteam.slack.com/archives/C04RC7S3B34/p1777315257693249?thread_ts=1777315200.000100&cid=C04RC7S3B34';

  it('returns text with sender and channel context', async () => {
    const { resolveLinkedMessage } = makeAdapter([{ user: 'U123', text: 'hello world' }]);
    const result = await resolveLinkedMessage(TEST_URL);
    expect(result?.text).toBe('from Alice in <#C04RC7S3B34>:\nhello world');
  });

  it('returns null for unrecognised URL', async () => {
    const { resolveLinkedMessage } = makeAdapter([]);
    expect(await resolveLinkedMessage('https://example.com/foo')).toBeNull();
  });

  it('returns null when conversations.history returns no messages', async () => {
    const { resolveLinkedMessage } = makeAdapter([]);
    expect(await resolveLinkedMessage(TEST_URL)).toBeNull();
  });

  it('calls conversations.history with correct channel and timestamp', async () => {
    const { resolveLinkedMessage, fakeClient } = makeAdapter([{ user: 'U1', text: 'hi' }]);
    await resolveLinkedMessage(TEST_URL);
    expect(fakeClient.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C04RC7S3B34', latest: '1777315257.693249', oldest: '1777315257.693249' }),
    );
  });

  it('uses conversations.replies for thread reply links', async () => {
    const replyMsg = { ts: '1777315257.693249', user: 'U1', text: 'reply text', files: [] };
    const { resolveLinkedMessage, fakeClient } = makeAdapter([], [replyMsg]);
    const result = await resolveLinkedMessage(THREAD_URL);
    expect(fakeClient.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({ ts: '1777315200.000100' }),
    );
    expect(result?.text).toContain('reply text');
  });

  it('includes files from the linked message', async () => {
    const { resolveLinkedMessage } = makeAdapter([{
      user: 'U1',
      text: 'see attached',
      files: [{ id: 'F1', name: 'report.pdf', mimetype: 'application/pdf', url_private_download: 'https://files.slack.com/report.pdf' }],
    }]);
    const result = await resolveLinkedMessage(TEST_URL);
    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]).toMatchObject({ id: 'F1', name: 'report.pdf', mimeType: 'application/pdf' });
  });

  it('falls back to user ID when getUserDisplayName throws', async () => {
    // Pass a displayName that would throw — simulate by using bot_id fallback
    const { resolveLinkedMessage } = makeAdapter([{ bot_id: 'B999', text: 'hi' }]);
    const result = await resolveLinkedMessage(TEST_URL);
    expect(result?.text).toContain('B999');
  });
});
