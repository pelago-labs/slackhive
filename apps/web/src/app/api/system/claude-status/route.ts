/**
 * @fileoverview GET /api/system/claude-status — check Claude auth status.
 *
 * Settings-only (no host Keychain / `claude login`):
 *   1. ~/.claude/.credentials.json (synced from Settings by the runner)
 *   2. Fallback: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env vars
 *
 * @module web/api/system/claude-status
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { ensureFreshClaudeToken } from '@/lib/claude-auth';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const dynamic = 'force-dynamic';

interface ClaudeStatus {
  status: 'connected' | 'disconnected' | 'expired';
  source: 'file' | 'keychain' | 'env' | 'none';
  expiresAt?: number;
  expiresIn?: string;
  error?: string;
}

function readCredentialsFile(): { accessToken?: string; expiresAt?: number } | null {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    if (!fs.existsSync(credPath)) return null;
    const content = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    return content?.claudeAiOauth ?? null;
  } catch { return null; }
}

function formatExpiresIn(expiresAtMs: number): string {
  const remaining = expiresAtMs - Date.now();
  if (remaining <= 0) return 'expired';
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(remaining / (60 * 1000));
  return `${mins}m`;
}

export async function GET(req: NextRequest): Promise<NextResponse<ClaudeStatus>> {
  const denied = guardAdmin(req);
  if (denied) return denied as NextResponse<ClaudeStatus>;
  // 1. Live creds (macOS Keychain first, else file) + self-heal an expired token.
  const oauth = (await ensureFreshClaudeToken().catch(() => null)) ?? readCredentialsFile();
  const source: ClaudeStatus['source'] = 'file';

  // 2. Env var fallback.
  if (!oauth?.accessToken) {
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
    if (envToken) return NextResponse.json({ status: 'connected', source: 'env' });
    return NextResponse.json({ status: 'disconnected', source: 'none' });
  }

  // `expiresAt` is a refresh hint, not a hard server expiry — the token keeps
  // working past it. Report connected when a token exists; if past the hint and
  // auto-refresh failed, flag that renewal needs a re-login (don't cry "expired").
  const stale = !!(oauth.expiresAt && Date.now() > oauth.expiresAt);
  return NextResponse.json({
    status: 'connected',
    source,
    ...(oauth.expiresAt && { expiresAt: oauth.expiresAt, expiresIn: stale ? 'renew on re-login' : formatExpiresIn(oauth.expiresAt) }),
    ...(stale && { error: 'Token works, but auto-refresh is unavailable — re-enter Claude credentials to restore renewal.' }),
  });
}
