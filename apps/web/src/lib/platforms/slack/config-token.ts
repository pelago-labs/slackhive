/**
 * @fileoverview Slack App Configuration token keeper.
 *
 * Slack's App Manifest APIs (apps.manifest.create etc.) require an App
 * Configuration access token (`xoxe.xoxp-…`) that expires every 12 hours. The
 * admin pastes the matching REFRESH token (`xoxe-1-…`) once (Settings → Slack app
 * automation); this module transparently rotates it via `tooling.tokens.rotate`
 * whenever the cached access token is stale.
 *
 * CRITICAL: every rotation returns a NEW refresh token and invalidates the old
 * one (chained rotation) — the new one is persisted immediately or the flow
 * breaks and the admin must re-paste.
 *
 * Storage (settings table, token material encrypted with the app key):
 *  - slack_config_refresh_token  (encrypted)
 *  - slack_config_access_token   (encrypted)
 *  - slack_config_token_exp      (epoch seconds, plain)
 *
 * @module web/lib/platforms/slack/config-token
 */

import { encrypt, decrypt } from '@slackhive/shared';
import { getSetting, setSetting, deleteSetting } from '@/lib/db';
import { getEncryptionKey } from '@/lib/secrets';

export const REFRESH_TOKEN_KEY = 'slack_config_refresh_token';
export const ACCESS_TOKEN_KEY = 'slack_config_access_token';
export const TOKEN_EXP_KEY = 'slack_config_token_exp';

/** Refresh this many seconds before the reported expiry. */
const EXPIRY_MARGIN_S = 120;

export class SlackConfigTokenError extends Error {
  constructor(
    /** 'missing' → not set up yet; 'invalid' → revoked/expired, admin must re-paste. */
    public code: 'missing' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

/** Single-flight guard so concurrent provisions trigger exactly one rotation. */
let inflightRotation: Promise<string> | null = null;

/** True when a refresh token has been configured. */
export async function isConfigTokenConfigured(): Promise<boolean> {
  return Boolean(await getSetting(REFRESH_TOKEN_KEY));
}

/** Epoch seconds the cached access token expires at, or null when absent. */
export async function getConfigTokenExpiry(): Promise<number | null> {
  const exp = await getSetting(TOKEN_EXP_KEY);
  return exp ? Number(exp) : null;
}

/**
 * Returns a valid App Configuration access token, rotating via
 * `tooling.tokens.rotate` when the cached one is missing or near expiry.
 *
 * @throws {SlackConfigTokenError} code 'missing' when never configured,
 *   'invalid' when Slack rejects the refresh token (revoked → re-paste).
 */
export async function getConfigAccessToken(): Promise<string> {
  const expRaw = await getSetting(TOKEN_EXP_KEY);
  const exp = expRaw ? Number(expRaw) : 0;
  const cached = await getSetting(ACCESS_TOKEN_KEY);
  if (cached && exp - EXPIRY_MARGIN_S > Date.now() / 1000) {
    return decrypt(cached, getEncryptionKey());
  }
  if (!inflightRotation) {
    inflightRotation = rotateConfigToken().finally(() => { inflightRotation = null; });
  }
  return inflightRotation;
}

/**
 * Stores a freshly pasted refresh token and validates it by rotating once.
 * On rotation failure the stored value is cleared again so the settings UI
 * keeps reporting "not configured" rather than a poisoned state.
 */
export async function saveConfigRefreshToken(refreshToken: string): Promise<void> {
  await setSetting(REFRESH_TOKEN_KEY, encrypt(refreshToken.trim(), getEncryptionKey()));
  try {
    await rotateConfigToken();
  } catch (err) {
    await clearConfigToken();
    throw err;
  }
}

/** Forgets all stored config-token material. */
export async function clearConfigToken(): Promise<void> {
  await deleteSetting(REFRESH_TOKEN_KEY);
  await deleteSetting(ACCESS_TOKEN_KEY);
  await deleteSetting(TOKEN_EXP_KEY);
}

async function rotateConfigToken(): Promise<string> {
  const encRefresh = await getSetting(REFRESH_TOKEN_KEY);
  if (!encRefresh) {
    throw new SlackConfigTokenError('missing', 'Slack app automation is not set up — paste an App Configuration refresh token in Settings.');
  }
  const key = getEncryptionKey();
  const res = await fetch('https://slack.com/api/tooling.tokens.rotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: decrypt(encRefresh, key) }),
  });
  const d = (await res.json()) as {
    ok: boolean; token?: string; refresh_token?: string; exp?: number; error?: string;
  };
  if (!d.ok || !d.token || !d.refresh_token) {
    throw new SlackConfigTokenError('invalid', `Slack rejected the App Configuration token (${d.error ?? 'unknown error'}) — generate a new one at api.slack.com/apps and re-paste it in Settings.`);
  }
  // Persist the NEW refresh token first — the old one is now dead.
  await setSetting(REFRESH_TOKEN_KEY, encrypt(d.refresh_token, key));
  await setSetting(ACCESS_TOKEN_KEY, encrypt(d.token, key));
  await setSetting(TOKEN_EXP_KEY, String(d.exp ?? Math.floor(Date.now() / 1000) + 12 * 3600));
  return d.token;
}
