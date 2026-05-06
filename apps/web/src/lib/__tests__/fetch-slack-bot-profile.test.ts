/**
 * @fileoverview Tests for fetchSlackBotProfile — the auth.test → users.info
 * chain that resolves a bot's display handle, user id, and avatar image URL.
 *
 * @module web/lib/__tests__/fetch-slack-bot-profile.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all DB dependencies the module pulls in transitively.
vi.mock('@slackhive/shared', async () => {
  const actual = await vi.importActual<typeof import('@slackhive/shared')>('@slackhive/shared');
  return { ...actual, getDb: vi.fn(() => ({ query: vi.fn() })) };
});

import { fetchSlackBotProfile } from '@/lib/db';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); });

function jsonRes(body: unknown) {
  return { json: async () => body } as unknown as Response;
}

describe('fetchSlackBotProfile', () => {
  it('returns all-null when auth.test returns ok:false', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: false }));
    const r = await fetchSlackBotProfile('xoxb-bad');
    expect(r).toEqual({ handle: null, userId: null, imageUrl: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns handle + userId but null imageUrl when users.info fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ ok: true, user: 'mybot', user_id: 'U123' }))
      .mockResolvedValueOnce(jsonRes({ ok: false }));
    const r = await fetchSlackBotProfile('xoxb-good');
    expect(r).toEqual({ handle: 'mybot', userId: 'U123', imageUrl: null });
  });

  it('returns image_192 when users.info returns it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ ok: true, user: 'mybot', user_id: 'U123' }))
      .mockResolvedValueOnce(jsonRes({
        ok: true,
        user: { profile: { image_192: 'https://avatars.slack-edge.com/192.png' } },
      }));
    const r = await fetchSlackBotProfile('xoxb-good');
    expect(r.imageUrl).toBe('https://avatars.slack-edge.com/192.png');
  });

  it('falls back to image_72 when image_192 is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ ok: true, user: 'mybot', user_id: 'U123' }))
      .mockResolvedValueOnce(jsonRes({
        ok: true,
        user: { profile: { image_72: 'https://avatars.slack-edge.com/72.png' } },
      }));
    const r = await fetchSlackBotProfile('xoxb-good');
    expect(r.imageUrl).toBe('https://avatars.slack-edge.com/72.png');
  });

  it('returns all-null on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const r = await fetchSlackBotProfile('xoxb-bad');
    expect(r).toEqual({ handle: null, userId: null, imageUrl: null });
  });

  it('skips users.info when auth.test omits user_id', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, user: 'mybot' }));
    const r = await fetchSlackBotProfile('xoxb-good');
    expect(r).toEqual({ handle: 'mybot', userId: null, imageUrl: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses Bearer auth on both API calls', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ ok: true, user: 'mybot', user_id: 'U123' }))
      .mockResolvedValueOnce(jsonRes({ ok: true, user: { profile: { image_192: 'x' } } }));
    await fetchSlackBotProfile('xoxb-good');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/auth.test',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer xoxb-good' }) })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('users.info?user=U123'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer xoxb-good' }) })
    );
  });
});
