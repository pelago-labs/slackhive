/**
 * @fileoverview Codex (ChatGPT) credential state for the web layer.
 *
 * Reads ~/.codex/auth.json and reports whether the login is usable, expired, or
 * absent. Crucially, a `codex logout` REVOKES the session server-side while
 * leaving the access token's `exp` date intact — so a local date check alone
 * reports a false "connected". To catch that, `codexAuthStateLive()` makes a
 * cached, read-only validation request (the access token as a bearer; it never
 * touches the refresh token) and treats a 401 as expired.
 *
 * @module web/lib/codex-auth
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type AuthState = { status: 'connected' | 'expired' | 'none'; source: string };

/** Read-only endpoint that accepts the Codex access token (aud: api.openai.com/v1). */
const VALIDATE_URL = 'https://api.openai.com/v1/models';
/** Cache live-validation per access token so the 30s status poll doesn't hammer it. */
const CACHE_MS = 25_000;
let cache: { token: string; state: AuthState; at: number } | null = null;

/** Decode a JWT's `exp` (epoch ms), or null if not a decodable JWT. */
function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function readAuth(): { tokens?: { access_token?: string }; OPENAI_API_KEY?: string; auth_mode?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(codexHome(), 'auth.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Fast, offline state: file presence + access-token `exp` date only. Cannot see a
 * server-side revocation (logout). Use `codexAuthStateLive()` for the truth.
 */
export function codexAuthState(): AuthState {
  const auth = readAuth();
  if (!auth) {
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return { status: 'connected', source: 'env' };
    return { status: 'none', source: 'none' };
  }
  const at = auth?.tokens?.access_token;
  if (!at) {
    if (auth?.OPENAI_API_KEY || process.env.OPENAI_API_KEY) return { status: 'connected', source: 'apikey' };
    return { status: 'none', source: 'none' };
  }
  const exp = jwtExpMs(at);
  if (exp && Date.now() > exp) return { status: 'expired', source: 'login' };
  return { status: 'connected', source: 'login' };
}

/**
 * Authoritative state: starts from the offline verdict, then for a subscription
 * login token confirms it isn't revoked via a cached read-only API call. A 401
 * ("token_invalidated") → expired; a success → connected; anything inconclusive
 * (network error, 403/429/5xx) falls back to the offline date verdict so a blip
 * never raises a false "expired".
 */
export async function codexAuthStateLive(): Promise<AuthState> {
  const base = codexAuthState();
  // Only a real login token can be silently revoked; env/api-key/none can't be
  // cheaply validated here, so trust the offline verdict for those.
  if (base.source !== 'login') return base;

  const at = readAuth()?.tokens?.access_token;
  if (!at) return base;

  const now = Date.now();
  if (cache && cache.token === at && now - cache.at < CACHE_MS) return cache.state;

  let state = base;
  try {
    const r = await fetch(VALIDATE_URL, { headers: { Authorization: `Bearer ${at}` } });
    if (r.status === 401) state = { status: 'expired', source: 'login' };
    else if (r.ok) state = { status: 'connected', source: 'login' };
    // else: inconclusive (403/429/5xx) — keep the offline verdict.
  } catch {
    // Network error — don't false-alarm; keep the offline verdict.
  }
  cache = { token: at, state, at: now };
  return state;
}
