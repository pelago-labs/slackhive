/**
 * @fileoverview Codex ChatGPT device-auth login, driven from the web UI so no
 * host CLI / keychain access is needed (works headlessly).
 *
 * POST  /api/system/codex-login — start `codex login --device-auth`; returns the
 *       verification URL + one-time code. The process keeps polling OpenAI in the
 *       background and, on success, writes ~/.codex/auth.json; we then persist it
 *       (encrypted) to Settings so the runner re-materializes it on restart.
 * GET   /api/system/codex-login — poll the in-flight login status.
 *
 * @module web/api/system/codex-login
 */

import { NextRequest, NextResponse } from 'next/server';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encrypt } from '@slackhive/shared';
import { setSetting, publishAgentEvent, getAllAgents } from '@/lib/db';
import { getEncryptionKey } from '@/lib/secrets';
import { guardAdmin } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface LoginState {
  proc: ChildProcess;
  status: 'pending' | 'connected' | 'failed';
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  output: string;
}

// Persists across requests within the single `next start` process.
let current: LoginState | null = null;

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Resolve a runnable codex binary: CODEX_PATH → bundled platform package → PATH. */
function resolveCodexBinary(): string {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  const pkg = `@openai/codex-${process.platform}-${arch}`;
  try {
    const root = path.dirname(require.resolve(`${pkg}/package.json`));
    const vendor = path.join(root, 'vendor');
    if (fs.existsSync(vendor)) {
      for (const triple of fs.readdirSync(vendor)) {
        const bin = path.join(vendor, triple, 'bin', 'codex');
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch { /* fall through */ }
  return 'codex';
}

function parseDeviceInfo(text: string, state: LoginState): void {
  if (!state.verificationUrl) {
    const url = text.match(/https?:\/\/[^\s'"]+/);
    if (url && /device|auth|activate|login/i.test(url[0])) state.verificationUrl = url[0];
  }
  if (!state.userCode) {
    const code = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
    if (code) state.userCode = code[1];
  }
}

async function persistAuthJson(): Promise<void> {
  const authPath = path.join(codexHome(), 'auth.json');
  if (!fs.existsSync(authPath)) return;
  const contents = fs.readFileSync(authPath, 'utf-8');
  await setSetting('secret:CODEX_AUTH_JSON', encrypt(contents, getEncryptionKey()));
  await setSetting('codexAuthMode', 'subscription');
  // Reload agents so a running CodexBackend picks up the new credentials.
  const agents = await getAllAgents();
  await Promise.all(agents.map((a) => publishAgentEvent({ type: 'reload', agentId: a.id }).catch(() => {})));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  // Reuse an in-flight pending login instead of spawning a second one.
  if (current && current.status === 'pending' && current.proc.exitCode === null) {
    return NextResponse.json({ status: 'pending', verificationUrl: current.verificationUrl, userCode: current.userCode });
  }

  const proc = spawn(resolveCodexBinary(), ['login', '--device-auth'], { env: process.env });
  const state: LoginState = { proc, status: 'pending', output: '' };
  current = state;

  const onData = (buf: Buffer) => { state.output += buf.toString(); parseDeviceInfo(state.output, state); };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);

  proc.on('error', (err) => { state.status = 'failed'; state.error = err.message; });
  proc.on('exit', async (code) => {
    if (code === 0 && fs.existsSync(path.join(codexHome(), 'auth.json'))) {
      try { await persistAuthJson(); state.status = 'connected'; }
      catch (e) { state.status = 'failed'; state.error = (e as Error).message; }
    } else if (state.status === 'pending') {
      state.status = 'failed';
      state.error = state.output.trim().split('\n').slice(-3).join('\n') || `codex login exited (${code})`;
    }
  });

  // Safety: don't let an abandoned device-login linger forever.
  const timer = setTimeout(() => { if (state.proc.exitCode === null) state.proc.kill(); }, LOGIN_TIMEOUT_MS);
  proc.on('exit', () => clearTimeout(timer));

  // Wait briefly for the URL + code to be printed, then return them.
  for (let i = 0; i < 40 && state.status === 'pending' && !(state.verificationUrl && state.userCode); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }

  if (state.status === 'failed') {
    return NextResponse.json({ status: 'failed', error: state.error }, { status: 502 });
  }
  return NextResponse.json({ status: state.status, verificationUrl: state.verificationUrl, userCode: state.userCode });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  if (!current) return NextResponse.json({ status: 'idle' });
  return NextResponse.json({
    status: current.status,
    verificationUrl: current.verificationUrl,
    userCode: current.userCode,
    error: current.error,
  });
}
