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
import { getSetting, getSettingUpdatedAt } from '../db';
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
 * Refresh an OAuth credential file from its stored secret — WITHOUT resurrecting
 * a file the user deleted by logging out. The live terminal login is the source
 * of truth:
 *  - File ABSENT (logged out / never logged in here): leave it absent. We must
 *    NOT recreate it — a `codex/claude logout` revokes the token server-side, so
 *    the stored snapshot is dead and reviving it would falsely report
 *    "connected". Remote/paste setups materialize the file at save time (in the
 *    web Settings PUT), not lazily on restart.
 *  - File PRESENT: don't clobber a token the CLI/SDK refreshed in place; only
 *    overwrite when the stored secret was re-saved more recently (operator
 *    pasted fresh creds in Settings).
 */
async function syncCredFile(secretKey: string, filePath: string, label: string): Promise<void> {
  const contents = await readSecret(secretKey);
  if (!contents) return;
  if (!fs.existsSync(filePath)) {
    logger.info(`No on-disk ${label} — leaving absent (terminal login/logout is the source of truth)`);
    return;
  }
  let write = false;
  try {
    const fileMtime = fs.statSync(filePath).mtimeMs;
    const secretAt = await getSettingUpdatedAt(`secret:${secretKey}`);
    // Overwrite only if the stored secret is newer (operator re-saved creds).
    write = secretAt != null && secretAt > fileMtime;
  } catch { /* keep the on-disk file */ }
  if (write) {
    writeSecretFile(filePath, contents);
    logger.info(`Synced ${label} from settings`);
  } else {
    logger.info(`Kept on-disk ${label} (newer than stored snapshot — preserving refreshed token)`);
  }
}

/**
 * Sync backend credentials from Settings to disk/env. Idempotent — safe to call
 * on every runner startup. Missing secrets are skipped (e.g. only the active
 * backend's credentials are usually present).
 */
export async function syncBackendCredentials(): Promise<void> {
  // Codex — don't clobber an auth.json the Codex CLI refreshed in place.
  await syncCredFile('CODEX_AUTH_JSON', path.join(codexHome(), 'auth.json'), 'Codex auth.json');
  const openaiKey = await readSecret('OPENAI_API_KEY');
  if (openaiKey) {
    process.env.OPENAI_API_KEY = openaiKey;
    logger.info('Loaded OPENAI_API_KEY from settings');
  }

  // Claude — don't clobber a credentials.json the SDK refreshed in place.
  await syncCredFile('CLAUDE_CREDENTIALS_JSON', path.join(claudeHome(), '.credentials.json'), 'Claude credentials.json');
  const anthropicKey = await readSecret('ANTHROPIC_API_KEY');
  if (anthropicKey) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
    logger.info('Loaded ANTHROPIC_API_KEY from settings');
  }
}
