/**
 * @fileoverview Materializes agent-backend credentials from the Settings table
 * onto disk/env at runner startup — replacing the old `slackhive init` auth step.
 *
 * Secrets are stored encrypted in the `settings` table under `secret:<KEY>` keys
 * (written by the web Settings page). Here we decrypt and:
 *  - Codex subscription  → write `~/.codex/auth.json` (0600). Forced file store
 *    (`cli_auth_credentials_store=file`) makes this work on macOS *and* Linux.
 *  - Codex API key       → export OPENAI_API_KEY into the runner env.
 *  - Claude subscription → write `~/.claude/.credentials.json` (0600).
 *  - Claude API key      → export ANTHROPIC_API_KEY into the runner env.
 *
 * @module runner/backends/credentials
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decrypt } from '@slackhive/shared';
import { getSetting } from '../db';
import { getEncryptionKey } from '../secrets';
import { logger } from '../logger';

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
function claudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

async function readSecret(secretKey: string): Promise<string | null> {
  const enc = await getSetting(`secret:${secretKey}`);
  if (!enc) return null;
  try {
    return decrypt(enc, getEncryptionKey());
  } catch (err) {
    logger.warn('Failed to decrypt backend secret', { secretKey, error: (err as Error).message });
    return null;
  }
}

function writeSecretFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}

/**
 * Sync backend credentials from Settings to disk/env. Idempotent — safe to call
 * on every runner startup. Missing secrets are skipped (e.g. only the active
 * backend's credentials are usually present).
 */
export async function syncBackendCredentials(): Promise<void> {
  // Codex
  const codexAuth = await readSecret('CODEX_AUTH_JSON');
  if (codexAuth) {
    writeSecretFile(path.join(codexHome(), 'auth.json'), codexAuth);
    logger.info('Synced Codex auth.json from settings', { dir: codexHome() });
  }
  const openaiKey = await readSecret('OPENAI_API_KEY');
  if (openaiKey) {
    process.env.OPENAI_API_KEY = openaiKey;
    logger.info('Loaded OPENAI_API_KEY from settings');
  }

  // Claude
  const claudeCreds = await readSecret('CLAUDE_CREDENTIALS_JSON');
  if (claudeCreds) {
    writeSecretFile(path.join(claudeHome(), '.credentials.json'), claudeCreds);
    logger.info('Synced Claude credentials.json from settings');
  }
  const anthropicKey = await readSecret('ANTHROPIC_API_KEY');
  if (anthropicKey) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
    logger.info('Loaded ANTHROPIC_API_KEY from settings');
  }
}
