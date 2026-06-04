/**
 * @fileoverview GET /api/system/backend-status — connection status of the
 * ACTIVE agent backend (Claude Code or Codex), so the dashboard badge reflects
 * whatever runtime agents currently run on rather than hardcoding "Claude".
 *
 * @module web/api/system/backend-status
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND, getBackendDescriptor,
} from '@slackhive/shared';
import { getSetting } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { claudeAuthStateLive, readClaudeOAuth } from '@/lib/claude-auth';
import { codexAuthStateLive } from '@/lib/codex-auth';

export const dynamic = 'force-dynamic';

interface BackendStatus {
  backend: string;
  label: string;
  status: 'connected' | 'disconnected' | 'expired';
  source?: string;
  expiresIn?: string;
  hint?: string;
}

function formatExpiresIn(expiresAtMs: number): string {
  const remaining = expiresAtMs - Date.now();
  if (remaining <= 0) return 'expired';
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d`;
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(remaining / 60_000)}m`;
}

async function claudeStatus(): Promise<BackendStatus> {
  const base = { backend: 'claude', label: 'Claude', hint: 'Set credentials in Settings → Agent Backend.' };
  // Self-heals (refresh) then confirms the token isn't revoked via a live check.
  const st = await claudeAuthStateLive();
  if (st.status === 'connected') {
    const o = readClaudeOAuth();
    return { ...base, status: 'connected', source: st.source, ...(o?.expiresAt && { expiresIn: formatExpiresIn(o.expiresAt) }) };
  }
  if (st.status === 'expired') {
    return {
      ...base,
      status: 'expired',
      source: st.source,
      hint: 'Claude session expired — run `claude login` on this machine (then Detect), or paste fresh credentials in Settings → Agent Backend.',
    };
  }
  // A stored API key is a deliberate, non-expiring credential the runner will
  // use — count it. But a stored OAuth-JSON secret is NOT proof of a working
  // login: it may hold a revoked/expired token (the live check above already had
  // its say), so it must not fake "connected".
  if (await getSetting('secret:ANTHROPIC_API_KEY')) {
    return { ...base, status: 'connected', source: 'settings' };
  }
  return { ...base, status: 'disconnected', source: 'none' };
}

async function codexStatus(): Promise<BackendStatus> {
  const base = { backend: 'codex', label: 'Codex', hint: 'Set ChatGPT login or an API key in Settings → Agent Backend.' };
  const st = await codexAuthStateLive();
  if (st.status === 'connected') return { ...base, status: 'connected', source: st.source };
  if (st.status === 'expired') {
    return {
      ...base,
      status: 'expired',
      source: st.source,
      hint: 'Codex session expired — run `codex login` on this machine (then Detect), or paste a fresh auth.json in Settings → Agent Backend.',
    };
  }
  // A stored API key counts (deliberate, non-expiring). A stored OAuth-JSON
  // secret does NOT — it may be a revoked/expired token, so it must not fake
  // "connected" (the live check above is authoritative for the login token).
  if (await getSetting('secret:OPENAI_API_KEY')) {
    return { ...base, status: 'connected', source: 'settings' };
  }
  return { ...base, status: 'disconnected', source: 'none' };
}

export async function GET(req: NextRequest): Promise<NextResponse<BackendStatus>> {
  const denied = guardAdmin(req);
  if (denied) return denied as NextResponse<BackendStatus>;

  const backend = (await getSetting(AGENT_BACKEND_SETTING_KEY)) ?? DEFAULT_AGENT_BACKEND;
  const label = getBackendDescriptor(backend)?.label ?? backend;
  const status = backend === 'codex' ? await codexStatus() : await claudeStatus();
  return NextResponse.json({ ...status, label });
}
