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
import { execFileSync } from 'child_process';
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

/**
 * On macOS, Claude Code stores the LIVE credentials in the login Keychain and
 * leaves only a stale copy in ~/.claude/.credentials.json. The terminal `claude`
 * and the Agent SDK read the Keychain (auto-refreshed); reading the file alone
 * makes us report a false "expired". So prefer the Keychain when present.
 */
function readClaudeKeychain(): ClaudeOAuth | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
    return JSON.parse(out)?.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function readClaudeFile(): ClaudeOAuth | null {
  try {
    return JSON.parse(fs.readFileSync(credPath(), 'utf-8'))?.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

export function readClaudeOAuth(): ClaudeOAuth | null {
  // Keychain (live on macOS) wins over the on-disk snapshot.
  const kc = readClaudeKeychain();
  if (kc?.accessToken) return kc;
  return readClaudeFile();
}

/** Connected / expired / none — based on the live login's actual expiry. */
export function claudeAuthState(): { status: 'connected' | 'expired' | 'none'; source: string } {
  const o = readClaudeOAuth();
  if (o?.accessToken) {
    const source = process.platform === 'darwin' && readClaudeKeychain()?.accessToken ? 'login' : 'file';
    if (o.expiresAt && Date.now() > o.expiresAt) return { status: 'expired', source };
    return { status: 'connected', source };
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return { status: 'connected', source: 'env' };
  return { status: 'none', source: 'none' };
}

/** Read-only endpoint that accepts a Claude OAuth bearer token (no inference cost). */
const VALIDATE_URL = 'https://api.anthropic.com/v1/models';
/** Cache live validation per access token so the 30s status poll doesn't hammer it. */
const VALIDATE_CACHE_MS = 25_000;
let validateCache: { token: string; state: { status: 'connected' | 'expired' | 'none'; source: string }; at: number } | null = null;

/**
 * Authoritative state: self-heals a stale token (refresh), then confirms the
 * subscription OAuth token isn't revoked via a cached read-only API call — a
 * `claude logout` / server-side revocation invalidates the token while its local
 * `expiresAt` may still look fine. A 401 → expired; success → connected; anything
 * inconclusive (network error, 429/5xx) falls back to the offline verdict so a
 * blip never raises a false "expired". API-key/env auth is trusted as-is.
 */
export async function claudeAuthStateLive(): Promise<{ status: 'connected' | 'expired' | 'none'; source: string }> {
  // Refresh a near-expired file token first so we validate the freshest token.
  await ensureFreshClaudeToken().catch(() => null);
  const base = claudeAuthState();
  // Only OAuth login tokens (Keychain/file) can be silently revoked AND validated
  // with a Bearer call; env (which may be an x-api-key) is trusted offline.
  if (base.source !== 'login' && base.source !== 'file') return base;

  const token = readClaudeOAuth()?.accessToken;
  if (!token) return base;

  const now = Date.now();
  if (validateCache && validateCache.token === token && now - validateCache.at < VALIDATE_CACHE_MS) return validateCache.state;

  let state = base;
  try {
    const r = await fetch(VALIDATE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' } });
    if (r.status === 401 || r.status === 403) state = { status: 'expired', source: base.source };
    else if (r.ok) state = { status: 'connected', source: base.source };
    // else: inconclusive (429/5xx) — keep the offline verdict.
  } catch {
    // Network error — don't false-alarm; keep the offline verdict.
  }
  validateCache = { token, state, at: now };
  return state;
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
