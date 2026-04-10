/**
 * @fileoverview Unit tests for ClaudeHandler.refreshOAuthToken.
 *
 * Tests cover:
 * - Successful token refresh: reads credentials, calls token endpoint, writes new token
 * - Missing credentials file: returns false
 * - Missing refresh token in credentials: returns false
 * - Token endpoint returns error: returns false
 * - Token endpoint returns no access_token: returns false
 * - New refresh token is written when returned by endpoint
 *
 * @module runner/__tests__/oauth-refresh.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeHandler } from '../claude-handler.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
  vi.stubEnv('HOME', tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function writeCredentials(accessToken: string, refreshToken: string) {
  const credPath = path.join(tmpDir, '.claude', '.credentials.json');
  fs.writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken },
  }));
}

function readCredentials() {
  const credPath = path.join(tmpDir, '.claude', '.credentials.json');
  return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
}

describe('ClaudeHandler.refreshOAuthToken', () => {
  it('returns false when credentials file does not exist', async () => {
    const result = await ClaudeHandler.refreshOAuthToken();
    expect(result).toBe(false);
  });

  it('returns false when credentials have no refresh token', async () => {
    const credPath = path.join(tmpDir, '.claude', '.credentials.json');
    fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: 'old' } }));

    const result = await ClaudeHandler.refreshOAuthToken();
    expect(result).toBe(false);
  });

  it('returns false when token endpoint returns error', async () => {
    writeCredentials('old-access', 'valid-refresh');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    }));

    const result = await ClaudeHandler.refreshOAuthToken();
    expect(result).toBe(false);
  });

  it('returns false when response has no access_token', async () => {
    writeCredentials('old-access', 'valid-refresh');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    const result = await ClaudeHandler.refreshOAuthToken();
    expect(result).toBe(false);
  });

  it('refreshes token and writes new access token to credentials file', async () => {
    writeCredentials('old-access', 'valid-refresh');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-access' }),
    }));

    const result = await ClaudeHandler.refreshOAuthToken();
    expect(result).toBe(true);

    const creds = readCredentials();
    expect(creds.claudeAiOauth.accessToken).toBe('new-access');
    expect(creds.claudeAiOauth.refreshToken).toBe('valid-refresh');
  });

  it('writes new refresh token when returned by endpoint', async () => {
    writeCredentials('old-access', 'old-refresh');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    }));

    const result = await ClaudeHandler.refreshOAuthToken();
    expect(result).toBe(true);

    const creds = readCredentials();
    expect(creds.claudeAiOauth.accessToken).toBe('new-access');
    expect(creds.claudeAiOauth.refreshToken).toBe('new-refresh');
  });

  it('calls the correct OAuth endpoint with refresh token', async () => {
    writeCredentials('old-access', 'my-refresh-token');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-access' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await ClaudeHandler.refreshOAuthToken();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(opts.method).toBe('POST');
    expect(opts.body).toContain('grant_type=refresh_token');
    expect(opts.body).toContain('refresh_token=my-refresh-token');
  });
});
