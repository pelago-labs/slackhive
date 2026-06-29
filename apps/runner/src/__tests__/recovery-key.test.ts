import { describe, it, expect } from 'vitest';
import { wrapRecoveryKey, unwrapRecoveryKey, assertStrongRecoveryPassword, MIN_RECOVERY_PASSWORD_LENGTH } from '@slackhive/shared';

const PW = 'Tr0ub4dor&3xK9-mZqP!'; // strong: 20 chars, all 4 classes

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
    expect(() => unwrapRecoveryKey(blob, 'A-different-Str0ng-pw!')).toThrow(/wrong password|corrupted/i);
  });

  it('rejects a tampered blob', () => {
    const blob = wrapRecoveryKey('k', PW);
    const tampered = { ...blob, ct: Buffer.from('garbage-ciphertext').toString('base64') };
    expect(() => unwrapRecoveryKey(tampered, PW)).toThrow();
  });

  it('rejects an unrecognized blob format', () => {
    expect(() => unwrapRecoveryKey({ v: 2 } as never, PW)).toThrow(/format/i);
  });
});

describe('assertStrongRecoveryPassword', () => {
  it('accepts a strong password / passphrase', () => {
    expect(() => assertStrongRecoveryPassword(PW)).not.toThrow();
    expect(() => assertStrongRecoveryPassword('a long Diceware style passphrase 7')).not.toThrow(); // ≥24, ≥2 classes
  });

  it('enforces the minimum length', () => {
    expect(() => assertStrongRecoveryPassword('Short1!')).toThrow(new RegExp(String(MIN_RECOVERY_PASSWORD_LENGTH)));
  });

  it('rejects a famous/guessable passphrase', () => {
    expect(() => assertStrongRecoveryPassword('correct horse battery staple')).toThrow(/common|guessable/i);
  });

  it('rejects a single repeated character', () => {
    expect(() => assertStrongRecoveryPassword('aaaaaaaaaaaaaaaaaa')).toThrow(/repeated|variety/i);
  });

  it('rejects too few character classes for a short-ish password', () => {
    expect(() => assertStrongRecoveryPassword('alllowercaseletters')).toThrow(/simple|lowercase|uppercase/i);
  });

  it('is enforced by wrapRecoveryKey', () => {
    expect(() => wrapRecoveryKey('k', 'weak')).toThrow();
  });
});
