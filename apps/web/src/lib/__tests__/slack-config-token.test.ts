/**
 * @fileoverview Tests for the Slack App Configuration token keeper — caching,
 * rotation via tooling.tokens.rotate, chained refresh-token persistence,
 * single-flight, and error codes.
 *
 * @module web/lib/__tests__/slack-config-token.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt } from '@slackhive/shared';

const settings = new Map<string, string>();

vi.mock('@/lib/db', () => ({
  getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => { settings.set(k, v); }),
  deleteSetting: vi.fn(async (k: string) => { settings.delete(k); }),
}));

const TEST_KEY = 'test-encryption-key-for-config-token';
vi.mock('@/lib/secrets', () => ({ getEncryptionKey: () => TEST_KEY }));

import {
  getConfigAccessToken, saveConfigRefreshToken, clearConfigToken,
  isConfigTokenConfigured, SlackConfigTokenError,
  REFRESH_TOKEN_KEY, ACCESS_TOKEN_KEY, TOKEN_EXP_KEY,
} from '@/lib/platforms/slack/config-token';

const fetchMock = vi.fn();
beforeEach(() => {
  settings.clear();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); });

function rotateOk(token: string, refresh: string, expInSeconds = 12 * 3600) {
  return {
    json: async () => ({ ok: true, token, refresh_token: refresh, exp: Math.floor(Date.now() / 1000) + expInSeconds }),
  } as unknown as Response;
}

describe('slack config token keeper', () => {
  it('throws code missing when never configured', async () => {
    await expect(getConfigAccessToken()).rejects.toMatchObject({ code: 'missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rotates on first use and persists the NEW refresh token (chained rotation)', async () => {
    settings.set(REFRESH_TOKEN_KEY, encrypt('xoxe-1-old', TEST_KEY));
    fetchMock.mockResolvedValueOnce(rotateOk('xoxe.xoxp-access-1', 'xoxe-1-new'));

    const token = await getConfigAccessToken();
    expect(token).toBe('xoxe.xoxp-access-1');
    expect(decrypt(settings.get(REFRESH_TOKEN_KEY)!, TEST_KEY)).toBe('xoxe-1-new');
    expect(decrypt(settings.get(ACCESS_TOKEN_KEY)!, TEST_KEY)).toBe('xoxe.xoxp-access-1');
    expect(Number(settings.get(TOKEN_EXP_KEY))).toBeGreaterThan(Date.now() / 1000);
  });

  it('returns the cached access token without rotating when not near expiry', async () => {
    settings.set(REFRESH_TOKEN_KEY, encrypt('xoxe-1-r', TEST_KEY));
    settings.set(ACCESS_TOKEN_KEY, encrypt('cached-token', TEST_KEY));
    settings.set(TOKEN_EXP_KEY, String(Math.floor(Date.now() / 1000) + 3600));

    const token = await getConfigAccessToken();
    expect(token).toBe('cached-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rotates when the cached token is within the expiry margin', async () => {
    settings.set(REFRESH_TOKEN_KEY, encrypt('xoxe-1-r', TEST_KEY));
    settings.set(ACCESS_TOKEN_KEY, encrypt('stale-token', TEST_KEY));
    settings.set(TOKEN_EXP_KEY, String(Math.floor(Date.now() / 1000) + 30)); // < 120s margin
    fetchMock.mockResolvedValueOnce(rotateOk('fresh-token', 'xoxe-1-r2'));

    const token = await getConfigAccessToken();
    expect(token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent rotations', async () => {
    settings.set(REFRESH_TOKEN_KEY, encrypt('xoxe-1-r', TEST_KEY));
    fetchMock.mockResolvedValue(rotateOk('only-once', 'xoxe-1-r2'));

    const [a, b] = await Promise.all([getConfigAccessToken(), getConfigAccessToken()]);
    expect(a).toBe('only-once');
    expect(b).toBe('only-once');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws code invalid when Slack rejects the refresh token', async () => {
    settings.set(REFRESH_TOKEN_KEY, encrypt('xoxe-1-revoked', TEST_KEY));
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'invalid_refresh_token' }) } as unknown as Response);

    await expect(getConfigAccessToken()).rejects.toMatchObject({ code: 'invalid' });
  });

  it('saveConfigRefreshToken validates by rotating and clears on rejection', async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'invalid_refresh_token' }) } as unknown as Response);

    await expect(saveConfigRefreshToken('xoxe-1-bogus')).rejects.toBeInstanceOf(SlackConfigTokenError);
    expect(await isConfigTokenConfigured()).toBe(false);
  });

  it('saveConfigRefreshToken stores rotated material on success', async () => {
    fetchMock.mockResolvedValueOnce(rotateOk('access-x', 'xoxe-1-next'));

    await saveConfigRefreshToken('  xoxe-1-pasted  ');
    expect(await isConfigTokenConfigured()).toBe(true);
    expect(decrypt(settings.get(REFRESH_TOKEN_KEY)!, TEST_KEY)).toBe('xoxe-1-next');
  });

  it('clearConfigToken wipes all keys', async () => {
    settings.set(REFRESH_TOKEN_KEY, 'x');
    settings.set(ACCESS_TOKEN_KEY, 'y');
    settings.set(TOKEN_EXP_KEY, 'z');
    await clearConfigToken();
    expect(settings.size).toBe(0);
  });
});
