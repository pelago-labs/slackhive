/**
 * @fileoverview GET /api/system/claude-status — check Claude Code auth status
 *
 * Cross-platform (macOS + Linux):
 *   1. Check ~/.claude/.credentials.json (primary)
 *   2. macOS only: check Keychain
 *   3. Fallback: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env vars
 *
 * @module web/api/system/claude-status
 */

import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

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

function tryKeychainSync(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (creds) {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, creds, { mode: 0o600 });
      return true;
    }
  } catch { /* not found */ }
  return false;
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

export async function GET(): Promise<NextResponse<ClaudeStatus>> {
  // 1. Check credential file
  let oauth = readCredentialsFile();
  let source: ClaudeStatus['source'] = 'file';

  // 2. macOS: try Keychain sync if file is missing
  if (!oauth && process.platform === 'darwin') {
    if (tryKeychainSync()) {
      oauth = readCredentialsFile();
      if (oauth) source = 'keychain';
    }
  }

  // 3. Env var fallback
  if (!oauth?.accessToken) {
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
    if (envToken) {
      return NextResponse.json({ status: 'connected', source: 'env' });
    }
    return NextResponse.json({ status: 'disconnected', source: 'none' });
  }

  // 4. Check expiry — if expired, try Keychain sync first (SDK may have refreshed there)
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
    if (process.platform === 'darwin' && tryKeychainSync()) {
      const refreshed = readCredentialsFile();
      if (refreshed?.expiresAt && Date.now() < refreshed.expiresAt) {
        return NextResponse.json({ status: 'connected', source: 'keychain', expiresAt: refreshed.expiresAt, expiresIn: formatExpiresIn(refreshed.expiresAt) });
      }
    }
    return NextResponse.json({
      status: 'expired',
      source,
      expiresAt: oauth.expiresAt,
      error: 'Token expired. Run `claude login` on the host machine.',
    });
  }

  return NextResponse.json({
    status: 'connected',
    source,
    ...(oauth.expiresAt && { expiresAt: oauth.expiresAt, expiresIn: formatExpiresIn(oauth.expiresAt) }),
  });
}
