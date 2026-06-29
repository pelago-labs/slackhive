/**
 * @fileoverview Password-wrapped recovery key (key escrow) for disaster recovery.
 *
 * The database stores every secret as AES-256-GCM ciphertext keyed by `ENV_SECRET_KEY`
 * (see `crypto.ts`). A DB backup is therefore useless without that key. So an admin can
 * recover on a fresh host without hand-copying `.env`, this module wraps the encryption
 * key under a user-chosen password — `scrypt(password)` → AES-256-GCM — producing a small
 * JSON blob that is safe to download/store: it is cryptographically useless without the
 * password (its security reduces to password strength, hence the minimum length).
 *
 * The wrapped blob NEVER contains the plaintext key, and the plaintext key is never
 * written to disk by the exporter — only streamed to the downloading admin.
 *
 * @module @slackhive/shared/db/recovery-key
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const SALT_LEN = 16;
/** scrypt cost params (N must be a power of 2). ~32MB, raise maxmem to fit. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/** Minimum password length for a recovery-key export — it protects the master key. */
export const MIN_RECOVERY_PASSWORD_LENGTH = 12;

/** Shape of the downloadable recovery-key file (`slackhive-recovery-<stamp>.json`). */
export interface RecoveryBlob {
  v: 1;
  kdf: 'scrypt';
  /** scrypt cost params, captured so unwrap is forward-compatible if they change. */
  scrypt: { N: number; r: number; p: number };
  salt: string; // base64
  iv: string;   // base64
  tag: string;  // base64
  ct: string;   // base64 ciphertext of the encryption key
}

function deriveKey(password: string, salt: Buffer): Buffer {
  const { N, r, p, keylen, maxmem } = SCRYPT;
  return scryptSync(password, salt, keylen, { N, r, p, maxmem });
}

/**
 * Wrap the encryption key under `password`. Returns the JSON blob to download.
 * @throws if the password is shorter than {@link MIN_RECOVERY_PASSWORD_LENGTH}.
 */
export function wrapRecoveryKey(encryptionKey: string, password: string): RecoveryBlob {
  if (!password || password.length < MIN_RECOVERY_PASSWORD_LENGTH) {
    throw new Error(`Recovery-key password must be at least ${MIN_RECOVERY_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(encryptionKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: 'scrypt',
    scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * Unwrap a recovery blob with `password`, returning the original encryption key.
 * @throws on a wrong password or tampered blob (GCM auth-tag failure) — never returns
 *         partial/garbage output.
 */
export function unwrapRecoveryKey(blob: RecoveryBlob, password: string): string {
  if (!blob || blob.v !== 1 || blob.kdf !== 'scrypt') {
    throw new Error('Unrecognized recovery-key file format.');
  }
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const sc = blob.scrypt ?? { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  const key = scryptSync(password, salt, SCRYPT.keylen, { N: sc.N, r: sc.r, p: sc.p, maxmem: SCRYPT.maxmem });
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Wrong password or corrupted recovery-key file.');
  }
}
