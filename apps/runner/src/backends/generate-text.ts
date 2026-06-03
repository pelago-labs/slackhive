/**
 * @fileoverview Shared, backend-neutral one-shot text generation for SlackHive's
 * meta features (skill summaries, audience-instruction polish, /correct rewrites,
 * wiki/knowledge/analyze builders). Routes to the active agent backend so these
 * features work on Codex (ChatGPT subscription) as well as Claude — instead of
 * each caller hardcoding the Claude Agent SDK.
 *
 * @module runner/backends/generate-text
 */

import { AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND, CODEX_MODEL_SETTING_KEY } from '@slackhive/shared';
import { getSetting } from '../db';
import { logger } from '../logger';
import { ClaudeBackend } from './claude-backend';
import { createCodexClient, resolveCodexModel, baseCodexConfig } from './codex-config';

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
  const model = resolveCodexModel(await getSetting(CODEX_MODEL_SETTING_KEY));
  const codex = await createCodexClient(baseCodexConfig());
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
    logger.warn('generateText(claude): auth failed, refreshing token', { error: msg1.slice(0, 100) });
  }

  // Attempt 2: refresh the OAuth token in the Settings-synced credentials file,
  // then retry. (No host-Keychain fallback — auth is Settings-managed.)
  try {
    if (await ClaudeBackend.refreshOAuthToken()) return await runQuery();
  } catch { /* fall through */ }

  throw new Error('AUTH_NEEDS_LOGIN');
}
