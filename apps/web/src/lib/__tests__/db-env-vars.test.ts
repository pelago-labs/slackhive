/**
 * @fileoverview Unit tests for env var functions in db.ts.
 *
 * Verifies that setEnvVar, getEnvVarValues, getAllEnvVars, updateEnvVarDescription,
 * and deleteEnvVar issue the correct SQL — in particular that setEnvVar uses
 * AES-256 encryption (cipher-algo=aes256) rather than the pgcrypto default.
 *
 * No real database required — pg.Pool is mocked via vi.mock.
 *
 * @module web/lib/__tests__/db-env-vars.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock pg ─────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();

vi.mock('pg', () => {
  return {
    Pool: vi.fn().mockImplementation(function() { return { query: mockQuery }; }),
  };
});

// Set required env vars before importing db so the singleton pool initialises.
process.env.DATABASE_URL = 'postgresql://mock/db';
process.env.ENV_SECRET_KEY = 'test-secret-key-32-chars-padding!';

import {
  setEnvVar,
  getEnvVarValues,
  getAllEnvVars,
  updateEnvVarDescription,
  deleteEnvVar,
} from '@/lib/db';

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

// ─── setEnvVar ────────────────────────────────────────────────────────────────

describe('setEnvVar', () => {
  it('calls query with the correct number of parameters', async () => {
    await setEnvVar('MY_KEY', 'my-value');
    expect(mockQuery).toHaveBeenCalledOnce();
    const [, params] = mockQuery.mock.calls[0];
    // $1=key, $2=value, $3=encKey, $4=description
    expect(params).toHaveLength(4);
  });

  it('passes the key as $1', async () => {
    await setEnvVar('DB_URL', 'postgres://localhost');
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('DB_URL');
  });

  it('passes the plaintext value as $2 (encryption done in SQL)', async () => {
    await setEnvVar('DB_URL', 'postgres://localhost');
    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBe('postgres://localhost');
  });

  it('passes ENV_SECRET_KEY as $3', async () => {
    await setEnvVar('MY_KEY', 'val');
    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBe('test-secret-key-32-chars-padding!');
  });

  it('passes null as $4 when description is omitted', async () => {
    await setEnvVar('MY_KEY', 'val');
    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toBeNull();
  });

  it('passes description as $4 when provided', async () => {
    await setEnvVar('MY_KEY', 'val', 'My description');
    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toBe('My description');
  });

  it('uses pgp_sym_encrypt with cipher-algo=aes256 for INSERT', async () => {
    await setEnvVar('MY_KEY', 'val');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("pgp_sym_encrypt($2, $3, 'cipher-algo=aes256')");
  });

  it('uses pgp_sym_encrypt with cipher-algo=aes256 for ON CONFLICT UPDATE', async () => {
    await setEnvVar('MY_KEY', 'val');
    const [sql] = mockQuery.mock.calls[0];
    // Both the INSERT value and the UPSERT update value must use AES-256
    const matches = (sql as string).match(/cipher-algo=aes256/g);
    expect(matches).toHaveLength(2);
  });

  it('uses an INSERT … ON CONFLICT upsert pattern', async () => {
    await setEnvVar('MY_KEY', 'val');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO env_vars/i);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });
});

// ─── getEnvVarValues ──────────────────────────────────────────────────────────

describe('getEnvVarValues', () => {
  it('decrypts values with pgp_sym_decrypt', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await getEnvVarValues();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('pgp_sym_decrypt');
  });

  it('passes ENV_SECRET_KEY as parameter', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await getEnvVarValues();
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('test-secret-key-32-chars-padding!');
  });

  it('returns a key→value record from query rows', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { key: 'FOO', value: 'bar' },
        { key: 'BAZ', value: 'qux' },
      ],
    });
    const result = await getEnvVarValues();
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns an empty object when no rows', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await getEnvVarValues();
    expect(result).toEqual({});
  });
});

// ─── getAllEnvVars ────────────────────────────────────────────────────────────

describe('getAllEnvVars', () => {
  it('queries key, description, and updated_at', async () => {
    await getAllEnvVars();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('key');
    expect(sql).toContain('description');
    expect(sql).toContain('updated_at');
  });

  it('never selects the encrypted value column', async () => {
    await getAllEnvVars();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('pgp_sym_decrypt');
  });

  it('maps rows to objects with key, description, and updatedAt', async () => {
    const now = new Date();
    mockQuery.mockResolvedValue({
      rows: [{ key: 'MY_KEY', description: 'desc', updated_at: now }],
    });
    const result = await getAllEnvVars();
    expect(result).toEqual([{ key: 'MY_KEY', description: 'desc', updatedAt: now }]);
  });

  it('sets description to undefined when null in DB', async () => {
    const now = new Date();
    mockQuery.mockResolvedValue({
      rows: [{ key: 'MY_KEY', description: null, updated_at: now }],
    });
    const [row] = await getAllEnvVars();
    expect(row.description).toBeUndefined();
  });
});

// ─── updateEnvVarDescription ──────────────────────────────────────────────────

describe('updateEnvVarDescription', () => {
  it('issues an UPDATE on env_vars', async () => {
    await updateEnvVarDescription('MY_KEY', 'new desc');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE env_vars/i);
  });

  it('passes key and description as parameters', async () => {
    await updateEnvVarDescription('MY_KEY', 'new desc');
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain('MY_KEY');
    expect(params).toContain('new desc');
  });

  it('does not touch the encrypted value column', async () => {
    await updateEnvVarDescription('MY_KEY', 'new desc');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('pgp_sym_encrypt');
  });
});

// ─── deleteEnvVar ─────────────────────────────────────────────────────────────

describe('deleteEnvVar', () => {
  it('issues a DELETE on env_vars', async () => {
    await deleteEnvVar('MY_KEY');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM env_vars/i);
  });

  it('passes the key as the only parameter', async () => {
    await deleteEnvVar('MY_KEY');
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['MY_KEY']);
  });
});
