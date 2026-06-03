/**
 * @fileoverview Shared, backend-neutral one-shot text generation for SlackHive's
 * meta features (skill summaries, audience-instruction polish, /correct rewrites,
 * wiki/knowledge/analyze builders). Routes to the active agent backend so these
 * features work on Codex (ChatGPT subscription) as well as Claude — instead of
 * each caller hardcoding the Claude Agent SDK.
 *
 * @module runner/backends/generate-text
 */

import {
  AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND,
  CODEX_MODEL_SETTING_KEY, DEFAULT_CODEX_MODEL,
} from '@slackhive/shared';
import { getSetting } from '../db';
import { logger } from '../logger';
import { ClaudeBackend } from './claude-backend';

export interface GenerateOpts {
  /** System prompt / role instructions. */
  systemPrompt?: string;
  /** Claude model id to use on the Claude backend (ignored on Codex). */
  claudeModel?: string;
  /** Progress callback (chars produced so far). */
  onProgress?: (chars: number) => void;
}

/** Generate text via the active agent backend (Codex or Claude). */
export async function generateText(prompt: string, opts: GenerateOpts = {}): Promise<string> {
  const backend = (await getSetting(AGENT_BACKEND_SETTING_KEY)) ?? DEFAULT_AGENT_BACKEND;
  return backend === 'codex' ? generateViaCodex(prompt, opts) : generateViaClaude(prompt, opts);
}

// ── Codex ────────────────────────────────────────────────────────────────────

async function generateViaCodex(prompt: string, opts: GenerateOpts): Promise<string> {
  const os = await import('os');
  const { Codex } = await import('@openai/codex-sdk');
  const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || undefined;
  let model = (await getSetting(CODEX_MODEL_SETTING_KEY)) ?? DEFAULT_CODEX_MODEL;
  if (/^claude/i.test(model)) model = DEFAULT_CODEX_MODEL;
  const codex = new Codex({
    ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
    ...(apiKey ? { apiKey } : {}),
    config: { cli_auth_credentials_store: 'file' },
  });
  // Codex has no separate system-prompt param; prepend it to the turn input.
  const input = opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt;
  const thread = codex.startThread({
    workingDirectory: os.tmpdir(),
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    model,
  });
  const turn = await thread.run(input);
  const text = turn.finalResponse ?? '';
  opts.onProgress?.(text.length);
  return text;
}

// ── Claude (with keychain + OAuth-refresh retry) ─────────────────────────────

async function generateViaClaude(prompt: string, opts: GenerateOpts): Promise<string> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const os = await import('os');

  const options: Record<string, unknown> = {
    permissionMode: 'bypassPermissions',
    allowedTools: [],
    tools: [],
    maxTurns: 1,
    cwd: os.tmpdir(),
    ...(opts.claudeModel ? { model: opts.claudeModel } : {}),
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
  };

  const runQuery = async (): Promise<string> => {
    let text = '';
    for await (const msg of query({ prompt, options })) {
      const m = msg as { type: string; message?: { content?: { type: string; text?: string }[] }; result?: string };
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text) { text += block.text; opts.onProgress?.(text.length); }
        }
      } else if (m.type === 'result' && m.result) {
        if (m.result.includes('authentication_error') || m.result.includes('Failed to authenticate')) throw new Error(m.result);
        text = m.result;
      }
    }
    return text;
  };

  // Attempt 1: direct.
  try {
    return await runQuery();
  } catch (err1) {
    const msg1 = (err1 as Error).message ?? '';
    if (!msg1.includes('401') && !msg1.includes('auth') && !msg1.includes('credentials')) throw err1;
    logger.warn('generateText(claude): auth failed, trying keychain sync', { error: msg1.slice(0, 100) });
  }

  // Attempt 2: macOS Keychain sync, then retry.
  try {
    const { execSync } = await import('child_process');
    const fs = await import('fs');
    const path = await import('path');
    const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (creds) {
      const credPath = path.join(process.env.HOME || '/tmp', '.claude', '.credentials.json');
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, creds, { mode: 0o600 });
      return await runQuery();
    }
  } catch { /* fall through to refresh */ }

  // Attempt 3: refresh OAuth token, then retry.
  try {
    if (await ClaudeBackend.refreshOAuthToken()) return await runQuery();
  } catch { /* fall through */ }

  throw new Error('AUTH_NEEDS_LOGIN');
}
