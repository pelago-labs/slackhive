/**
 * @fileoverview AES-256-GCM encryption for env var values.
 *
 * Replaces PostgreSQL's pgp_sym_encrypt/pgp_sym_decrypt with pure Node.js
 * crypto for database-agnostic secret storage.
 *
 * Format: base64(iv + authTag + ciphertext)
 *   - iv:         12 bytes (96-bit, GCM standard)
 *   - authTag:    16 bytes (128-bit)
 *   - ciphertext: variable length
 *
 * @module @slackhive/shared/db/crypto
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Derives a 32-byte key from the ENV_SECRET_KEY passphrase.
 * Uses SHA-256 for deterministic key derivation (matching pgcrypto behavior).
 */
function deriveKey(passphrase: string): Buffer {
  return createHash('sha256').update(passphrase).digest();
}

/**
 * Encrypts a plaintext value using AES-256-GCM.
 *
 * @param plaintext - The value to encrypt.
 * @param passphrase - The encryption key (ENV_SECRET_KEY).
 * @returns Base64-encoded ciphertext blob.
 */
export function encrypt(plaintext: string, passphrase: string): string {
  const key = deriveKey(passphrase);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypts a base64-encoded ciphertext blob using AES-256-GCM.
 *
 * @param encoded - Base64 string from encrypt().
 * @param passphrase - The encryption key (ENV_SECRET_KEY).
 * @returns The original plaintext.
 * @throws If decryption fails (wrong key, tampered data).
 */
export function decrypt(encoded: string, passphrase: string): string {
  const key = deriveKey(passphrase);
  const packed = Buffer.from(encoded, 'base64');

  const iv = packed.subarray(0, IV_LEN);
  const authTag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = packed.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
