import { describe, it, expect } from 'vitest';
import { wrapRecoveryKey, unwrapRecoveryKey, MIN_RECOVERY_PASSWORD_LENGTH } from '@slackhive/shared';

const PW = 'correct horse battery staple'; // ≥ 12 chars

describe('recovery key wrap/unwrap', () => {
  it('round-trips the encryption key', () => {
    const key = 'super-secret-ENV_SECRET_KEY-value';
    const blob = wrapRecoveryKey(key, PW);
    expect(blob.v).toBe(1);
    expect(blob.ct).not.toContain(key); // never stored in plaintext
    expect(unwrapRecoveryKey(blob, PW)).toBe(key);
  });

  it('rejects a wrong password (no partial output)', () => {
    const blob = wrapRecoveryKey('k', PW);
    expect(() => unwrapRecoveryKey(blob, 'a different password!')).toThrow(/wrong password|corrupted/i);
  });

  it('rejects a tampered blob', () => {
    const blob = wrapRecoveryKey('k', PW);
    const tampered = { ...blob, ct: Buffer.from('garbage-ciphertext').toString('base64') };
    expect(() => unwrapRecoveryKey(tampered, PW)).toThrow();
  });

  it('enforces the minimum password length on export', () => {
    expect(() => wrapRecoveryKey('k', 'short')).toThrow(new RegExp(String(MIN_RECOVERY_PASSWORD_LENGTH)));
  });

  it('rejects an unrecognized blob format', () => {
    expect(() => unwrapRecoveryKey({ v: 2 } as never, PW)).toThrow(/format/i);
  });
});
