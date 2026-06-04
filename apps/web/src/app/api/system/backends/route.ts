/**
 * @fileoverview AI Provider (agent backend) settings API.
 *
 * GET  /api/system/backends — backend descriptors + current selection + which
 *      credential fields are set (never returns secret values).
 * PUT  /api/system/backends — persist backend choice / model / auth modes and
 *      (encrypted) credentials, then reload all agents so the change takes effect.
 *
 * @module web/api/system/backends
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  BACKEND_DESCRIPTORS, getBackendDescriptor,
  AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND,
  CLAUDE_AUTH_MODE_SETTING_KEY, CODEX_AUTH_MODE_SETTING_KEY,
  COACH_MODEL_SETTING_KEY, DEFAULT_AGENT_MODEL, DEFAULT_CODEX_MODEL, DEFAULT_COACH_MODEL,
  encrypt,
} from '@slackhive/shared';
import { getSetting, setSetting, publishAgentEvent, getAllAgents, updateAgent } from '@/lib/db';
import { getEncryptionKey } from '@/lib/secrets';
import { guardAdmin } from '@/lib/api-guard';
import { readClaudeOAuth } from '@/lib/claude-auth';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const dynamic = 'force-dynamic';

/** Whether each backend already has usable credentials, and where from. */
function detectCredentials(secretsSet: Record<string, boolean>): Record<string, { detected: boolean; source: string }> {
  // Claude: macOS Keychain or file (live login), env, or stored secret.
  let claude: { detected: boolean; source: string } = { detected: false, source: 'none' };
  if (readClaudeOAuth()?.accessToken) claude = { detected: true, source: process.platform === 'darwin' ? 'login' : 'file' };
  else if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) claude = { detected: true, source: 'env' };
  else if (secretsSet.CLAUDE_CREDENTIALS_JSON || secretsSet.ANTHROPIC_API_KEY) claude = { detected: true, source: 'settings' };

  // Codex: ~/.codex/auth.json (login), env, or stored secret.
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let codex: { detected: boolean; source: string } = { detected: false, source: 'none' };
  try { if (fs.existsSync(path.join(codexHome, 'auth.json'))) codex = { detected: true, source: 'login' }; } catch { /* ignore */ }
  if (!codex.detected) {
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) codex = { detected: true, source: 'env' };
    else if (secretsSet.CODEX_AUTH_JSON || secretsSet.OPENAI_API_KEY) codex = { detected: true, source: 'settings' };
  }
  return { claude, codex };
}

/** All credential field keys across every backend descriptor. */
function allSecretKeys(): string[] {
  const keys = new Set<string>();
  for (const d of BACKEND_DESCRIPTORS) {
    for (const opt of d.authOptions) for (const f of opt.fields) keys.add(f.secretKey);
  }
  return [...keys];
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const secretsSet: Record<string, boolean> = {};
  for (const key of allSecretKeys()) {
    const v = await getSetting(`secret:${key}`);
    secretsSet[key] = v != null && v !== ''; // a cleared secret is stored as '' — treat as unset
  }

  return NextResponse.json({
    descriptors: BACKEND_DESCRIPTORS,
    current: {
      backend: (await getSetting(AGENT_BACKEND_SETTING_KEY)) ?? DEFAULT_AGENT_BACKEND,
      claudeAuthMode: (await getSetting(CLAUDE_AUTH_MODE_SETTING_KEY)) ?? 'subscription',
      codexAuthMode: (await getSetting(CODEX_AUTH_MODE_SETTING_KEY)) ?? 'subscription',
    },
    secretsSet,
    detected: detectCredentials(secretsSet),
  });
}

interface PutBody {
  backend?: string;
  claudeAuthMode?: string;
  codexAuthMode?: string;
  /** secretKey → plaintext value (encrypted before storage). Empty string clears. */
  secrets?: Record<string, string>;
  /** Backend id to disconnect: clears its stored secrets + removes the materialized file. */
  disconnect?: string;
}

/**
 * When the backend changes, migrate any model that isn't valid for the new
 * backend (e.g. a Claude id after switching to Codex) to that backend's default,
 * for every agent and the Coach model. Models already valid for the new backend
 * are left untouched so deliberate per-agent choices survive.
 */
async function migrateModelsForBackend(backend: string): Promise<void> {
  const desc = getBackendDescriptor(backend);
  if (!desc) return;
  const valid = new Set(desc.models.map((m) => m.value));
  const agentDefault = backend === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_AGENT_MODEL;
  const coachDefault = backend === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_COACH_MODEL;

  const agents = await getAllAgents();
  await Promise.all(
    agents.filter((a) => !valid.has(a.model)).map((a) => updateAgent(a.id, { model: agentDefault }).catch(() => {})),
  );

  const coach = await getSetting(COACH_MODEL_SETTING_KEY);
  if (!coach || !valid.has(coach)) await setSetting(COACH_MODEL_SETTING_KEY, coachDefault);
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const body = (await req.json()) as PutBody;

  // Disconnect: forget SlackHive's stored credentials for a backend AND remove
  // the materialized login file, so a terminal logout is reflected (no stale
  // copy resurrecting it on restart). The live Keychain login (Claude on macOS)
  // is the user's own and is left untouched.
  if (body.disconnect) {
    const desc = getBackendDescriptor(body.disconnect);
    if (desc) {
      for (const opt of desc.authOptions) for (const f of opt.fields) {
        await setSetting(`secret:${f.secretKey}`, '');
      }
      try {
        const home = os.homedir();
        const file = body.disconnect === 'codex'
          ? path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json')
          : path.join(home, '.claude', '.credentials.json');
        fs.rmSync(file, { force: true });
      } catch { /* ignore */ }
    }
    return NextResponse.json({ ok: true });
  }

  if (body.backend !== undefined) {
    if (!getBackendDescriptor(body.backend)) {
      return NextResponse.json({ error: `unknown backend: ${body.backend}` }, { status: 400 });
    }
    const prev = (await getSetting(AGENT_BACKEND_SETTING_KEY)) ?? DEFAULT_AGENT_BACKEND;
    await setSetting(AGENT_BACKEND_SETTING_KEY, body.backend);
    if (body.backend !== prev) await migrateModelsForBackend(body.backend);
  }
  if (body.claudeAuthMode !== undefined) await setSetting(CLAUDE_AUTH_MODE_SETTING_KEY, body.claudeAuthMode);
  if (body.codexAuthMode !== undefined) await setSetting(CODEX_AUTH_MODE_SETTING_KEY, body.codexAuthMode);

  if (body.secrets) {
    const valid = new Set(allSecretKeys());
    for (const [key, value] of Object.entries(body.secrets)) {
      if (!valid.has(key)) continue; // ignore unknown keys
      // Empty value clears the secret; otherwise store encrypted.
      await setSetting(`secret:${key}`, value ? encrypt(value, getEncryptionKey()) : '');
    }
  }

  // Reload every agent so the new backend / credentials take effect.
  const agents = await getAllAgents();
  await Promise.all(agents.map((a) => publishAgentEvent({ type: 'reload', agentId: a.id }).catch(() => {})));

  return NextResponse.json({ ok: true });
}
