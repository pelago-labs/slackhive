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

export const dynamic = 'force-dynamic';

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
    secretsSet[key] = (await getSetting(`secret:${key}`)) != null;
  }

  return NextResponse.json({
    descriptors: BACKEND_DESCRIPTORS,
    current: {
      backend: (await getSetting(AGENT_BACKEND_SETTING_KEY)) ?? DEFAULT_AGENT_BACKEND,
      claudeAuthMode: (await getSetting(CLAUDE_AUTH_MODE_SETTING_KEY)) ?? 'subscription',
      codexAuthMode: (await getSetting(CODEX_AUTH_MODE_SETTING_KEY)) ?? 'subscription',
    },
    secretsSet,
  });
}

interface PutBody {
  backend?: string;
  claudeAuthMode?: string;
  codexAuthMode?: string;
  /** secretKey → plaintext value (encrypted before storage). Empty string clears. */
  secrets?: Record<string, string>;
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
