/**
 * @fileoverview Centralized secret resolution with fail-fast semantics.
 *
 * Two keys the app needs:
 *   - AUTH_SECRET — HMAC key for session cookies
 *   - ENV_SECRET_KEY — symmetric key for encrypting platform credentials at rest
 *
 * Both must be provided via env outside development. Development mode falls
 * back to a well-known placeholder and logs a loud warning, so tests and
 * local `next dev` still work without manual setup. CI explicitly counts as
 * non-development — CI pipelines are expected to inject test secrets.
 *
 * Previously these fallbacks were scattered literals inline with the read
 * sites (`process.env.X ?? 'slackhive-default-key'`). That meant anyone with
 * source access could decrypt database-at-rest secrets if the env var was
 * missed in production. This module fails the boot instead.
 *
 * @module web/lib/secrets
 */

import * as fs from 'fs';
import * as path from 'path';

function isDevOnly(): boolean {
  return process.env.NODE_ENV === 'development' && !process.env.CI;
}

const DEV_AUTH_SECRET = 'dev-only-auth-secret-set-AUTH_SECRET-for-real-use';
const DEV_ENCRYPTION_KEY = 'dev-only-encryption-key-set-ENV_SECRET_KEY-for-real-use';

let warnedAuth = false;
let warnedEnc = false;
let envFilePermsChecked = false;

/**
 * Refuses to boot if `.env` is group/world readable.
 *
 * Background: the .env file holds AUTH_SECRET, ENV_SECRET_KEY, ADMIN_PASSWORD.
 * Mode 664 (group + world readable, our prior default) means any process on
 * the host — including any subprocess an agent spawns — can `cat` it and
 * forge sessions or decrypt credentials at rest. mode 600 closes that.
 *
 * The check runs lazily on first secret read in non-dev so a freshly
 * deployed host that forgot `chmod 600` fails fast and visibly instead of
 * silently leaking. Override the path via `SLACKHIVE_ENV_FILE` if you keep
 * .env somewhere other than `process.cwd()`.
 */
/** Reset the once-only check flag. Tests only. */
export function _resetEnvFilePermsCheckForTests(): void {
  envFilePermsChecked = false;
}

export function assertEnvFileLockedDown(): void {
  if (envFilePermsChecked) return;
  // Skip in dev OR when running tests (vitest / jest set NODE_ENV=test) —
  // tests instantiate getAuthSecret/getEncryptionKey hundreds of times and
  // shouldn't be coupled to the host's .env file mode. The dedicated
  // secrets-env-file-perms.test.ts sets SLACKHIVE_ENV_FILE to its own tmp
  // file and forces NODE_ENV=production to exercise this code path.
  if (isDevOnly() || process.env.NODE_ENV === 'test') return;
  envFilePermsChecked = true;

  const envPath = process.env.SLACKHIVE_ENV_FILE ?? path.resolve(process.cwd(), '.env');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(envPath);
  } catch {
    // No .env file — env vars are coming from systemd / docker env_file / shell.
    // That's a valid deploy shape; nothing to check.
    return;
  }

  // Mode bits: any group OR world permission (0o077 = group rwx + other rwx).
  const looseBits = stat.mode & 0o077;
  if (looseBits !== 0) {
    const currentMode = (stat.mode & 0o777).toString(8);
    throw new Error(
      `${envPath} has insecure permissions (mode ${currentMode}). ` +
      `This file holds AUTH_SECRET / ENV_SECRET_KEY / ADMIN_PASSWORD; group or world ` +
      `read leaks them to any process on the host. Run: chmod 600 ${envPath}`,
    );
  }
}

/**
 * HMAC key used to sign and verify session cookies.
 * Fails fast at boot if unset outside development.
 */
export function getAuthSecret(): string {
  assertEnvFileLockedDown();
  const v = process.env.AUTH_SECRET;
  if (v) return v;
  if (!isDevOnly()) {
    throw new Error(
      'AUTH_SECRET must be set (sessions cannot be signed without it). See .env.example.'
    );
  }
  if (!warnedAuth) {
    warnedAuth = true;
    console.warn('[secrets] DEV MODE: using default AUTH_SECRET. Set AUTH_SECRET for real use.');
  }
  return DEV_AUTH_SECRET;
}

/**
 * Symmetric key used to encrypt Slack bot/app tokens and MCP secrets in the
 * database. Distinct from AUTH_SECRET so rotating session keys does not break
 * stored credentials. Falls back to AUTH_SECRET only if ENV_SECRET_KEY is
 * unset — fails fast if both are unset outside development.
 */
export function getEncryptionKey(): string {
  assertEnvFileLockedDown();
  const v = process.env.ENV_SECRET_KEY ?? process.env.AUTH_SECRET;
  if (v) return v;
  if (!isDevOnly()) {
    throw new Error(
      'ENV_SECRET_KEY (or AUTH_SECRET as fallback) must be set. ' +
      'This key encrypts credentials at rest — running without it would make ' +
      'any stored secret trivially decryptable. See .env.example.'
    );
  }
  if (!warnedEnc) {
    warnedEnc = true;
    console.warn('[secrets] DEV MODE: using default ENV_SECRET_KEY. Set ENV_SECRET_KEY for real use.');
  }
  return DEV_ENCRYPTION_KEY;
}

/**
 * Superadmin password from env. Same fail-fast rules as the other secrets.
 */
export function getAdminPassword(): string {
  const v = process.env.ADMIN_PASSWORD;
  if (v) return v;
  if (!isDevOnly()) {
    throw new Error('ADMIN_PASSWORD must be set. See .env.example.');
  }
  return 'changeme';
}
