/**
 * @fileoverview Claude (Anthropic) OAuth token refresh for the web layer.
 *
 * The Claude subscription credentials in ~/.claude/.credentials.json carry a
 * refresh token. When the access token expires we mint a fresh one via the
 * OAuth token endpoint and persist it BOTH to the credentials file (so the
 * Agent SDK + status checks see it) AND to the encrypted `secret:` setting (so
 * a runner restart doesn't clobber it with the stale snapshot). This lets the
 * "expired" status self-heal instead of getting stuck.
 *
 * @module web/lib/claude-auth
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encrypt } from '@slackhive/shared';
import { getEncryptionKey } from './secrets';
import { setSetting } from './db';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** Refresh slightly before the hard expiry so we never hand out a dead token. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface ClaudeOAuth { accessToken?: string; refreshToken?: string; expiresAt?: number }

function credPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

export function readClaudeOAuth(): ClaudeOAuth | null {
  try {
    return JSON.parse(fs.readFileSync(credPath(), 'utf-8'))?.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

/**
 * Refresh the Claude access token using the stored refresh token. Persists the
 * new token + expiry to the credentials file and the encrypted secret.
 *
 * @returns the new `expiresAt` (epoch ms) on success, or null if there's no
 *   refresh token / the refresh failed.
 */
export async function refreshClaudeToken(): Promise<number | null> {
  let creds: { claudeAiOauth?: ClaudeOAuth };
  try {
    creds = JSON.parse(fs.readFileSync(credPath(), 'utf-8'));
  } catch {
    return null;
  }
  const refreshToken = creds?.claudeAiOauth?.refreshToken;
  if (!refreshToken) return null;

  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPES,
      }).toString(),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    const expiresAt = Date.now() + (data.expires_in ? data.expires_in * 1000 : 8 * 60 * 60 * 1000);
    creds.claudeAiOauth = {
      ...creds.claudeAiOauth,
      accessToken: data.access_token,
      ...(data.refresh_token && { refreshToken: data.refresh_token }),
      expiresAt,
    };
    const json = JSON.stringify(creds, null, 2);
    try { fs.writeFileSync(credPath(), json, { mode: 0o600 }); } catch { /* file may be read-only in some envs */ }
    try { await setSetting('secret:CLAUDE_CREDENTIALS_JSON', encrypt(json, getEncryptionKey())); } catch { /* best-effort persistence */ }
    return expiresAt;
  } catch {
    return null;
  }
}

/**
 * Returns a non-expired Claude OAuth (refreshing first if needed). null when
 * there are no usable credentials at all.
 */
export async function ensureFreshClaudeToken(): Promise<ClaudeOAuth | null> {
  const oauth = readClaudeOAuth();
  if (!oauth?.accessToken) return oauth;
  const stale = oauth.expiresAt != null && Date.now() > oauth.expiresAt - REFRESH_SKEW_MS;
  if (stale && oauth.refreshToken) {
    const newExpiry = await refreshClaudeToken();
    if (newExpiry) return readClaudeOAuth();
  }
  return oauth;
}
