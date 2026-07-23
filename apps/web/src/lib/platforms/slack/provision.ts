/**
 * @fileoverview Slack implementation of the platform provisioner: creates the
 * agent's Slack app from the generated manifest (apps.manifest.create), builds
 * the OAuth install redirect, and exchanges the install code for the bot token.
 *
 * The runner-facing credential blob {botToken, appToken, signingSecret} and the
 * reload bus are untouched — this module only automates how those values are
 * obtained. The app-level token (xapp) has no Slack API and stays a manual paste.
 *
 * @module web/lib/platforms/slack/provision
 */

import { randomUUID } from 'crypto';
import type { Agent } from '@slackhive/shared';
import { DEFAULT_SLACK_BOT_SCOPES, BOSS_ADDITIONAL_SCOPES } from '@slackhive/shared';
import { generateSlackManifest } from '@/lib/slack-manifest';
import {
  getSetting, setSetting, deleteSetting, listSettingsByPrefix,
  upsertSlackAppProvision, getSlackAppProvision, updateAgent,
} from '@/lib/db';
import { getConfigAccessToken, isConfigTokenConfigured, SlackConfigTokenError } from './config-token';
import { ProvisionError, type PlatformProvisioner, type ProvisionResult } from '../types';

/** Single-use install states expire after 15 minutes. */
const INSTALL_STATE_TTL_MS = 15 * 60 * 1000;

/** The shared callback route (not per-agent: state carries the agent id). */
export function installCallbackPath(): string {
  return '/api/slack/install/callback';
}

async function slackApi<T>(method: string, token: string | null, body: URLSearchParams | string, contentType?: string): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': contentType ?? 'application/x-www-form-urlencoded',
    },
    body,
  });
  return res.json() as Promise<T>;
}

export const slackProvisioner: PlatformProvisioner = {
  platform: 'slack',

  isConfigured: isConfigTokenConfigured,

  async provision(agent: Agent, origin: string): Promise<ProvisionResult> {
    // Slack only accepts https redirect URLs; on plain-http origins (localhost)
    // we skip redirect registration and degrade the install step to a manual
    // install link + bot-token paste.
    const useOauthRedirect = origin.startsWith('https://');
    const redirectUrl = useOauthRedirect ? `${origin}${installCallbackPath()}` : undefined;

    let token: string;
    try {
      token = await getConfigAccessToken();
    } catch (err) {
      if (err instanceof SlackConfigTokenError) {
        throw new ProvisionError(err.code === 'missing' ? 'not_configured' : 'invalid_config_token', err.message);
      }
      throw err;
    }

    const manifest = generateSlackManifest({
      name: agent.name,
      description: agent.description,
      isBoss: agent.isBoss,
      redirectUrl,
    });

    const d = await slackApi<{
      ok: boolean;
      app_id?: string;
      credentials?: { client_id: string; client_secret: string; verification_token?: string; signing_secret?: string };
      error?: string;
      errors?: unknown;
    }>('apps.manifest.create', token, JSON.stringify({ manifest }), 'application/json; charset=utf-8');

    if (!d.ok || !d.app_id || !d.credentials) {
      throw new ProvisionError('platform_rejected', `Slack rejected the app manifest (${d.error ?? 'unknown error'})`, d.errors ?? d.error);
    }

    await upsertSlackAppProvision(agent.id, {
      appId: d.app_id,
      clientId: d.credentials.client_id,
      clientSecret: d.credentials.client_secret,
      verificationToken: d.credentials.verification_token,
      signingSecret: d.credentials.signing_secret,
      redirectRegistered: useOauthRedirect,
    });

    return {
      appId: d.app_id,
      oauthRedirectRegistered: useOauthRedirect,
      installUrl: useOauthRedirect
        ? `/api/agents/${agent.id}/slack/install`
        : `https://api.slack.com/apps/${d.app_id}/install-on-team`,
    };
  },

  async buildInstallRedirect(agentId: string, origin: string): Promise<string | null> {
    const prov = await getSlackAppProvision(agentId);
    // No provisioned app, or the app was created without a registered redirect
    // URL (http origin at provision time) — Slack would reject the authorize
    // request with redirect_uri mismatch, so refuse up front.
    if (!prov || !prov.redirectRegistered) return null;

    await sweepExpiredInstallStates();
    const state = randomUUID();
    await setSetting(`slack_install_state:${state}`, JSON.stringify({ agentId, ts: Date.now() }));

    const params = new URLSearchParams({
      client_id: prov.clientId,
      scope: [...new Set([...DEFAULT_SLACK_BOT_SCOPES, ...BOSS_ADDITIONAL_SCOPES])].join(','),
      redirect_uri: `${origin}${installCallbackPath()}`,
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params}`;
  },
};

/** Removes abandoned single-use install states past their TTL (best-effort). */
async function sweepExpiredInstallStates(): Promise<void> {
  try {
    const rows = await listSettingsByPrefix('slack_install_state:');
    for (const row of rows) {
      let ts = 0;
      try { ts = (JSON.parse(row.value) as { ts?: number }).ts ?? 0; } catch { /* malformed → sweep */ }
      if (Date.now() - ts > INSTALL_STATE_TTL_MS) await deleteSetting(row.key);
    }
  } catch { /* sweeping is best-effort — never block an install on it */ }
}

/**
 * Resolves (and burns) a single-use install state without performing the code
 * exchange. Lets the callback route attribute even DENIED installs to the right
 * agent so errors surface on that agent's page instead of vanishing.
 * Returns null for unknown, malformed, or expired states.
 */
export async function consumeInstallState(state: string): Promise<{ agentId: string } | null> {
  const key = `slack_install_state:${state}`;
  const raw = await getSetting(key);
  if (raw) await deleteSetting(key); // single-use, burn immediately
  try {
    const parsed = raw ? (JSON.parse(raw) as { agentId: string; ts: number }) : null;
    if (!parsed || Date.now() - parsed.ts > INSTALL_STATE_TTL_MS) return null;
    return { agentId: parsed.agentId };
  } catch {
    return null;
  }
}

/** Outcome of the OAuth install callback exchange. */
export interface InstallCallbackResult {
  agentId: string;
  botUserId?: string;
}

/**
 * Exchanges the OAuth code for the bot token for an already state-resolved
 * agent, merging it into the credential blob (updateAgent merge semantics).
 * Deliberately does NOT publish a reload — the app-level token is still missing
 * and the runner would only park the agent as unconfigured.
 *
 * @throws Error with a short machine-readable message used as ?install_error=…
 */
export async function handleInstallCallback(code: string, agentId: string, origin: string): Promise<InstallCallbackResult> {
  const prov = await getSlackAppProvision(agentId);
  if (!prov) throw new Error('not_provisioned');

  const d = await slackApi<{
    ok: boolean;
    access_token?: string;
    bot_user_id?: string;
    error?: string;
  }>('oauth.v2.access', null, new URLSearchParams({
    code,
    client_id: prov.clientId,
    client_secret: prov.clientSecret,
    redirect_uri: `${origin}${installCallbackPath()}`,
  }));

  if (!d.ok || !d.access_token) throw new Error('exchange');

  // Merge the bot token into the credential blob; updateAgent also resolves and
  // caches the bot handle + avatar via fetchSlackBotProfile.
  await updateAgent(agentId, { platformCredentials: { botToken: d.access_token } });

  return { agentId, botUserId: d.bot_user_id };
}
