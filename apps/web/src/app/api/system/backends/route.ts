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
  encrypt,
} from '@slackhive/shared';
import { getSetting, setSetting, publishAgentEvent, getAllAgents } from '@/lib/db';
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

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const body = (await req.json()) as PutBody;

  if (body.backend !== undefined) {
    if (!getBackendDescriptor(body.backend)) {
      return NextResponse.json({ error: `unknown backend: ${body.backend}` }, { status: 400 });
    }
    await setSetting(AGENT_BACKEND_SETTING_KEY, body.backend);
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
