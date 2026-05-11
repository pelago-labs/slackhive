/**
 * @fileoverview Tests for the runner-side env-var snapshot cache.
 *
 * Without the cache, every agent start re-decrypts the entire env_vars
 * table. The cache holds the decrypted map for 5min or until a
 * `env-vars-changed` event invalidates it via `flushEnvVarsCache`.
 *
 * We assert:
 * - First call hits the DB; second call within TTL does not.
 * - `flushEnvVarsCache()` re-arms the next call.
 * - The cache contents are identical to a non-cached read.
 *
 * @module runner/__tests__/env-var-cache.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSqliteAdapter,
  setDb,
  getDb,
  closeDb,
  encrypt,
  type DbAdapter,
} from '@slackhive/shared';

import { getAllEnvVarValues, flushEnvVarsCache } from '../db';

let dbPath: string;
let queries: string[];
let wrapped: DbAdapter;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-var-cache-'));
  dbPath = path.join(tmpDir, 'data.db');
  const real = createSqliteAdapter(dbPath);
  queries = [];
  wrapped = {
    type: real.type,
    query: async (sql, params) => { queries.push(sql); return real.query(sql, params); },
    transaction: (fn) => real.transaction(fn),
    close: () => real.close(),
  };
  setDb(wrapped);
  process.env.ENV_SECRET_KEY = 'a'.repeat(64); // 32-byte hex key for AES-256
  flushEnvVarsCache(); // ensure clean slate
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  flushEnvVarsCache();
  vi.restoreAllMocks();
});

async function seedEnvVar(key: string, value: string): Promise<void> {
  const enc = encrypt(value, process.env.ENV_SECRET_KEY!);
  await getDb().query(
    `INSERT INTO env_vars (key, value, description, created_by) VALUES ($1, $2, $3, $4)`,
    [key, enc, null, 'admin']
  );
}

function envSelectCount(): number {
  return queries.filter(q => /FROM env_vars/i.test(q)).length;
}

describe('getAllEnvVarValues cache', () => {
  it('first call SELECTs from env_vars; second call within TTL does not', async () => {
    await seedEnvVar('FOO', 'bar');

    queries.length = 0;
    const first = await getAllEnvVarValues();
    expect(first).toEqual({ FOO: 'bar' });
    expect(envSelectCount()).toBe(1);

    const second = await getAllEnvVarValues();
    expect(second).toEqual({ FOO: 'bar' });
    expect(envSelectCount()).toBe(1); // still 1 — no second SELECT
  });

  it('flushEnvVarsCache forces a fresh SELECT on the next call', async () => {
    await seedEnvVar('FOO', 'bar');
    await getAllEnvVarValues(); // prime
    queries.length = 0;

    flushEnvVarsCache();
    await getAllEnvVarValues();
    expect(envSelectCount()).toBe(1);
  });

  it('returns up-to-date values after flush even if a new row was inserted', async () => {
    await seedEnvVar('FOO', 'bar');
    expect(await getAllEnvVarValues()).toEqual({ FOO: 'bar' });

    // Add a new row, but don't flush yet — cached snapshot should NOT include it.
    await seedEnvVar('BAZ', 'qux');
    expect(await getAllEnvVarValues()).toEqual({ FOO: 'bar' });

    // After flush, the next call rebuilds the snapshot.
    flushEnvVarsCache();
    expect(await getAllEnvVarValues()).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns empty map when ENV_SECRET_KEY is unset (no cache poisoning)', async () => {
    delete process.env.ENV_SECRET_KEY;
    flushEnvVarsCache();
    expect(await getAllEnvVarValues()).toEqual({});
  });
});
