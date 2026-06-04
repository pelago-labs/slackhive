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
import { claudeAuthStateLive, readClaudeOAuth } from '@/lib/claude-auth';

export const dynamic = 'force-dynamic';

interface ClaudeStatus {
  status: 'connected' | 'disconnected' | 'expired';
  source: string;
  expiresAt?: number;
  expiresIn?: string;
  error?: string;
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
  // Self-heals (refresh) then confirms the token isn't revoked via a live check.
  const st = await claudeAuthStateLive();
  const o = readClaudeOAuth();

  if (st.status === 'expired') {
    return NextResponse.json({
      status: 'expired',
      source: st.source,
      ...(o?.expiresAt && { expiresAt: o.expiresAt, expiresIn: 'expired' }),
      error: 'Claude session expired — run `claude login` on this machine, or paste fresh credentials.',
    });
  }
  if (st.status === 'none') return NextResponse.json({ status: 'disconnected', source: 'none' });

  return NextResponse.json({
    status: 'connected',
    source: st.source,
    ...(o?.expiresAt && { expiresAt: o.expiresAt, expiresIn: formatExpiresIn(o.expiresAt) }),
  });
}
