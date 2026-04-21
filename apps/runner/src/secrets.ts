/**
 * @fileoverview Centralized secret resolution for the runner with fail-fast
 * semantics. Mirrors apps/web/src/lib/secrets.ts — separate copy because the
 * runner cannot import from the Next.js app.
 *
 * @module runner/secrets
 */

function isDevOnly(): boolean {
  return process.env.NODE_ENV === 'development' && !process.env.CI;
}

const DEV_ENCRYPTION_KEY = 'dev-only-encryption-key-set-ENV_SECRET_KEY-for-real-use';

let warnedEnc = false;

/**
 * Symmetric key used to decrypt Slack bot/app tokens and MCP secrets from the
 * database. Falls back to AUTH_SECRET only if ENV_SECRET_KEY is unset — fails
 * fast if both are unset outside development.
 */
export function getEncryptionKey(): string {
  const v = process.env.ENV_SECRET_KEY ?? process.env.AUTH_SECRET;
  if (v) return v;
  if (!isDevOnly()) {
    throw new Error(
      'ENV_SECRET_KEY (or AUTH_SECRET as fallback) must be set. ' +
      'This key decrypts credentials at rest — running without it would make ' +
      'any stored secret trivially decryptable. See .env.example.'
    );
  }
  if (!warnedEnc) {
    warnedEnc = true;
    console.warn('[secrets] DEV MODE: using default ENV_SECRET_KEY. Set ENV_SECRET_KEY for real use.');
  }
  return DEV_ENCRYPTION_KEY;
}
