/**
 * @fileoverview Unit tests for env var functions in db.ts.
 *
 * Verifies setEnvVar, getEnvVarValues, getAllEnvVars, updateEnvVarDescription,
 * and deleteEnvVar against the DbAdapter. Encryption is app-layer (AES-256-GCM
 * via @slackhive/shared `encrypt`/`decrypt`) so values are pre-encrypted before
 * the query runs — the SQL itself has no pgcrypto call.
 *
 * No real database required — a fake DbAdapter is injected via setDb().
 *
 * @module web/lib/__tests__/db-env-vars.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDb, encrypt, decrypt, type DbAdapter, type DbResult } from '@slackhive/shared';

import {
  setEnvVar,
  getEnvVarValues,
  getAllEnvVars,
  updateEnvVarDescription,
  deleteEnvVar,
} from '@/lib/db';

// ─── Fake adapter ────────────────────────────────────────────────────────────

const mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<DbResult>>();

const fakeAdapter: DbAdapter = {
  query: mockQuery,
  transaction: async (fn) => fn(fakeAdapter),
  close: async () => {},
  type: 'sqlite',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  setDb(fakeAdapter);
});

// ─── setEnvVar ───────────────────────────────────────────────────────────────

describe('setEnvVar', () => {
  it('passes the key, encrypted value, and description as parameters', async () => {
    await setEnvVar('MY_KEY', 'my-value', 'a description');
    expect(mockQuery).toHaveBeenCalledOnce();
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toHaveLength(3);
    expect(params![0]).toBe('MY_KEY');
    expect(params![2]).toBe('a description');
  });

  it('encrypts the value before binding — ciphertext is not plaintext', async () => {
    await setEnvVar('SECRET', 'super-sensitive-value');
    const [, params] = mockQuery.mock.calls[0];
    expect(params![1]).not.toBe('super-sensitive-value');
    expect(typeof params![1]).toBe('string');
    expect((params![1] as string).length).toBeGreaterThan(0);
  });

  it('produces ciphertext decryptable with the same ENV_SECRET_KEY', async () => {
    const plain = 'round-trip-value';
    await setEnvVar('ROUND_TRIP', plain);
    const [, params] = mockQuery.mock.calls[0];
    const ciphertext = params![1] as string;
    expect(decrypt(ciphertext, process.env.ENV_SECRET_KEY!)).toBe(plain);
  });

  it('uses INSERT ... ON CONFLICT upsert pattern', async () => {
    await setEnvVar('UPSERT_KEY', 'value');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO env_vars');
    expect(sql).toContain('ON CONFLICT');
  });

  it('passes null for description when omitted', async () => {
    await setEnvVar('NO_DESC', 'value');
    const [, params] = mockQuery.mock.calls[0];
    expect(params![2]).toBeNull();
  });

  it('does not embed any pgp_sym_encrypt call in the SQL (app-layer encryption)', async () => {
    await setEnvVar('K', 'v');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('pgp_sym_encrypt');
    expect(sql).not.toContain('pgp_sym_decrypt');
  });

  it('produces a different ciphertext on each call (random IV)', async () => {
    await setEnvVar('K', 'same-value');
    const first = mockQuery.mock.calls[0][1]![1] as string;
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await setEnvVar('K', 'same-value');
    const second = mockQuery.mock.calls[0][1]![1] as string;
    expect(first).not.toBe(second);
  });
});

// ─── getEnvVarValues ─────────────────────────────────────────────────────────

describe('getEnvVarValues', () => {
  it('returns an empty object when no rows exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(getEnvVarValues()).resolves.toEqual({});
  });

  it('decrypts each row value using ENV_SECRET_KEY', async () => {
    const encKey = process.env.ENV_SECRET_KEY!;
    mockQuery.mockResolvedValueOnce({
      rows: [
        { key: 'A', value: encrypt('alpha', encKey) },
        { key: 'B', value: encrypt('beta', encKey) },
      ],
      rowCount: 2,
    });
    await expect(getEnvVarValues()).resolves.toEqual({ A: 'alpha', B: 'beta' });
  });

  it('selects key and value columns (no pgp_sym_decrypt in SQL)', async () => {
    await getEnvVarValues();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('SELECT key, value FROM env_vars');
    expect(sql).not.toContain('pgp_sym_decrypt');
  });
});

// ─── getAllEnvVars ───────────────────────────────────────────────────────────

describe('getAllEnvVars', () => {
  it('maps rows to { key, description, updatedAt } and sorts by key', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [
        { key: 'A_KEY', description: 'first', updated_at: now },
        { key: 'B_KEY', description: null, updated_at: now },
      ],
      rowCount: 2,
    });
    const result = await getAllEnvVars();
    expect(result).toEqual([
      { key: 'A_KEY', description: 'first', updatedAt: now },
      { key: 'B_KEY', description: undefined, updatedAt: now },
    ]);
    expect(mockQuery.mock.calls[0][0]).toContain('ORDER BY key');
  });

  it('never selects the value column', async () => {
    await getAllEnvVars();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/SELECT[^;]*\bvalue\b/);
  });
});

// ─── updateEnvVarDescription ─────────────────────────────────────────────────

describe('updateEnvVarDescription', () => {
  it('issues an UPDATE with key + description parameters', async () => {
    await updateEnvVarDescription('MY_KEY', 'new desc');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('UPDATE env_vars');
    expect(sql).toContain('SET description = $2');
    expect(params).toEqual(['MY_KEY', 'new desc']);
  });

  it('does not touch the value column', async () => {
    await updateEnvVarDescription('MY_KEY', 'new desc');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/SET[^;]*\bvalue\s*=/);
  });
});

// ─── deleteEnvVar ────────────────────────────────────────────────────────────

describe('deleteEnvVar', () => {
  it('issues a DELETE with the key parameter', async () => {
    await deleteEnvVar('DOOMED_KEY');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('DELETE FROM env_vars');
    expect(sql).toContain('WHERE key = $1');
    expect(params).toEqual(['DOOMED_KEY']);
  });
});
