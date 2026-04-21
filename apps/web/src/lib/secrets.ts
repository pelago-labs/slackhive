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

function isDevOnly(): boolean {
  return process.env.NODE_ENV === 'development' && !process.env.CI;
}

const DEV_AUTH_SECRET = 'dev-only-auth-secret-set-AUTH_SECRET-for-real-use';
const DEV_ENCRYPTION_KEY = 'dev-only-encryption-key-set-ENV_SECRET_KEY-for-real-use';

let warnedAuth = false;
let warnedEnc = false;

/**
 * HMAC key used to sign and verify session cookies.
 * Fails fast at boot if unset outside development.
 */
export function getAuthSecret(): string {
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
