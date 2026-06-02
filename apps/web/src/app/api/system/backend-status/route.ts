/**
 * @fileoverview GET /api/system/backend-status — connection status of the
 * ACTIVE agent backend (Claude Code or Codex), so the dashboard badge reflects
 * whatever runtime agents currently run on rather than hardcoding "Claude".
 *
 * @module web/api/system/backend-status
 */

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND, getBackendDescriptor,
} from '@slackhive/shared';
import { getSetting } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

interface BackendStatus {
  backend: string;
  label: string;
  status: 'connected' | 'disconnected' | 'expired';
  source?: 'file' | 'keychain' | 'env' | 'settings' | 'none';
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

function claudeStatus(): BackendStatus {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let oauth: { accessToken?: string; expiresAt?: number } | null = null;
  try {
    if (fs.existsSync(credPath)) oauth = JSON.parse(fs.readFileSync(credPath, 'utf-8'))?.claudeAiOauth ?? null;
  } catch { /* ignore */ }

  // macOS: sync from Keychain if the file is missing.
  if (!oauth && process.platform === 'darwin') {
    try {
      const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (creds) { fs.mkdirSync(path.dirname(credPath), { recursive: true }); fs.writeFileSync(credPath, creds, { mode: 0o600 }); oauth = JSON.parse(creds)?.claudeAiOauth ?? null; }
    } catch { /* not found */ }
  }

  const base = { backend: 'claude', label: 'Claude', hint: 'Run `claude login` on the host, or set credentials in Settings → Agent Backend.' };
  if (!oauth?.accessToken) {
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return { ...base, status: 'connected', source: 'env' };
    return { ...base, status: 'disconnected', source: 'none' };
  }
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) return { ...base, status: 'expired', source: 'file' };
  return { ...base, status: 'connected', source: 'file', ...(oauth.expiresAt && { expiresIn: formatExpiresIn(oauth.expiresAt) }) };
}

async function codexStatus(): Promise<BackendStatus> {
  const base = { backend: 'codex', label: 'Codex', hint: 'Set ChatGPT login or an API key in Settings → Agent Backend.' };
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (fs.existsSync(path.join(codexHome, 'auth.json'))) return { ...base, status: 'connected', source: 'file' };
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return { ...base, status: 'connected', source: 'env' };
  // Credentials stored in Settings (synced to disk/env by the runner on next start).
  if ((await getSetting('secret:CODEX_AUTH_JSON')) || (await getSetting('secret:OPENAI_API_KEY'))) {
    return { ...base, status: 'connected', source: 'settings' };
  }
  return { ...base, status: 'disconnected', source: 'none' };
}

export async function GET(req: NextRequest): Promise<NextResponse<BackendStatus>> {
  const denied = guardAdmin(req);
  if (denied) return denied as NextResponse<BackendStatus>;

  const backend = (await getSetting(AGENT_BACKEND_SETTING_KEY)) ?? DEFAULT_AGENT_BACKEND;
  const label = getBackendDescriptor(backend)?.label ?? backend;
  const status = backend === 'codex' ? await codexStatus() : claudeStatus();
  return NextResponse.json({ ...status, label });
}
