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
 * Validates a freshly pasted refresh token by rotating with it FIRST, and only
 * persists the rotated material on success — a bad paste never destroys a
 * previously working configuration (the stored token is left untouched).
 */
export async function saveConfigRefreshToken(refreshToken: string): Promise<void> {
  const rotated = await callRotateApi(refreshToken.trim());
  if (!rotated) {
    throw new SlackConfigTokenError('invalid', 'Slack rejected that App Configuration token — generate a new one at api.slack.com/apps (Your App Configuration Tokens) and paste the Refresh Token (xoxe-1-…).');
  }
  await persistRotation(rotated);
}

/** Forgets all stored config-token material. */
export async function clearConfigToken(): Promise<void> {
  await deleteSetting(REFRESH_TOKEN_KEY);
  await deleteSetting(ACCESS_TOKEN_KEY);
  await deleteSetting(TOKEN_EXP_KEY);
}

interface RotatedTokens { token: string; refreshToken: string; exp: number; }

/** Calls tooling.tokens.rotate; returns null when Slack rejects the token. */
async function callRotateApi(refreshToken: string): Promise<RotatedTokens | null> {
  const res = await fetch('https://slack.com/api/tooling.tokens.rotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken }),
  });
  const d = (await res.json()) as {
    ok: boolean; token?: string; refresh_token?: string; exp?: number; error?: string;
  };
  if (!d.ok || !d.token || !d.refresh_token) return null;
  return { token: d.token, refreshToken: d.refresh_token, exp: d.exp ?? Math.floor(Date.now() / 1000) + 12 * 3600 };
}

async function persistRotation(r: RotatedTokens): Promise<void> {
  const key = getEncryptionKey();
  // Persist the NEW refresh token first — the old one is now dead (chained rotation).
  await setSetting(REFRESH_TOKEN_KEY, encrypt(r.refreshToken, key));
  await setSetting(ACCESS_TOKEN_KEY, encrypt(r.token, key));
  await setSetting(TOKEN_EXP_KEY, String(r.exp));
}

async function rotateConfigToken(): Promise<string> {
  const encRefresh = await getSetting(REFRESH_TOKEN_KEY);
  if (!encRefresh) {
    throw new SlackConfigTokenError('missing', 'Slack app automation is not set up — paste an App Configuration refresh token in Settings.');
  }
  const key = getEncryptionKey();
  const rotated = await callRotateApi(decrypt(encRefresh, key));
  if (!rotated) {
    // Chained rotation means a concurrent rotation by another process kills our
    // refresh token. Before declaring the config invalid, re-read storage: if
    // someone else just rotated, a fresh access token is already there — use it.
    const expRaw = await getSetting(TOKEN_EXP_KEY);
    const cached = await getSetting(ACCESS_TOKEN_KEY);
    if (cached && expRaw && Number(expRaw) - EXPIRY_MARGIN_S > Date.now() / 1000) {
      const currentRefresh = await getSetting(REFRESH_TOKEN_KEY);
      if (currentRefresh !== encRefresh) return decrypt(cached, key);
    }
    throw new SlackConfigTokenError('invalid', 'Slack rejected the App Configuration token — generate a new one at api.slack.com/apps and re-paste it in Settings.');
  }
  await persistRotation(rotated);
  return rotated.token;
}
