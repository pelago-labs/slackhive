/**
 * @fileoverview Unit test for the cache-invalidation event dispatcher.
 *
 * The dispatcher is what wires `user-access-changed` / `env-vars-changed`
 * events to their respective flushes. Without this test, the wiring is
 * regression-prone: someone deleting a case from agent-runner's switch (or
 * forgetting to call the dispatcher) wouldn't be caught until a stale
 * `userCanTrigger` answer surfaces in prod.
 *
 * @module runner/__tests__/cache-event-dispatch.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter, setDb, closeDb, encrypt, type AgentEvent } from '@slackhive/shared';
import {
  dispatchCacheEvent,
  setCachedUserCanTrigger,
  getCachedUserCanTrigger,
  _accessCacheSize,
  _resetAccessCache,
} from '../access-cache';
import { getAllEnvVarValues, flushEnvVarsCache } from '../db';
import { getDb } from '@slackhive/shared';

let dbPath: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-dispatch-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
  process.env.ENV_SECRET_KEY = 'a'.repeat(64);
  _resetAccessCache();
  flushEnvVarsCache();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  _resetAccessCache();
  flushEnvVarsCache();
});

describe('dispatchCacheEvent', () => {
  it('user-access-changed with slackUserId drops just that user\'s entries', () => {
    setCachedUserCanTrigger('agent-A', 'U_KEEP', true);
    setCachedUserCanTrigger('agent-A', 'U_DROP', true);
    setCachedUserCanTrigger('agent-B', 'U_DROP', true);

    const handled = dispatchCacheEvent({ type: 'user-access-changed', slackUserId: 'U_DROP' } as AgentEvent);
    expect(handled).toBe(true);

    expect(getCachedUserCanTrigger('agent-A', 'U_KEEP')).toBe(true);
    expect(getCachedUserCanTrigger('agent-A', 'U_DROP')).toBeUndefined();
    expect(getCachedUserCanTrigger('agent-B', 'U_DROP')).toBeUndefined();
  });

  it('user-access-changed with BOTH agentId and slackUserId drops exactly one entry', () => {
    // The combined-key path is what grant/revoke routes hit. Other agents'
    // cache for the same user must NOT be touched — a grant on agent A
    // shouldn't invalidate the user's cache on agents B, C, D.
    setCachedUserCanTrigger('agent-A', 'U_X', true);
    setCachedUserCanTrigger('agent-B', 'U_X', true);
    setCachedUserCanTrigger('agent-A', 'U_Y', true);

    dispatchCacheEvent({ type: 'user-access-changed', agentId: 'agent-A', slackUserId: 'U_X' } as AgentEvent);

    expect(getCachedUserCanTrigger('agent-A', 'U_X')).toBeUndefined();
    expect(getCachedUserCanTrigger('agent-B', 'U_X')).toBe(true);
    expect(getCachedUserCanTrigger('agent-A', 'U_Y')).toBe(true);
  });

  it('user-access-changed with agentId drops just that agent\'s entries', () => {
    setCachedUserCanTrigger('agent-A', 'U_X', true);
    setCachedUserCanTrigger('agent-A', 'U_Y', true);
    setCachedUserCanTrigger('agent-B', 'U_X', true);

    dispatchCacheEvent({ type: 'user-access-changed', agentId: 'agent-A' } as AgentEvent);

    expect(getCachedUserCanTrigger('agent-A', 'U_X')).toBeUndefined();
    expect(getCachedUserCanTrigger('agent-A', 'U_Y')).toBeUndefined();
    expect(getCachedUserCanTrigger('agent-B', 'U_X')).toBe(true);
  });

  it('user-access-changed with userId-only triggers a coarse clear (worst case, intentional)', () => {
    setCachedUserCanTrigger('agent-A', 'U_X', true);
    setCachedUserCanTrigger('agent-B', 'U_Y', true);

    dispatchCacheEvent({ type: 'user-access-changed', userId: 'db-uuid' } as AgentEvent);

    // Coarse clear when only DB id is known. Per access-cache.ts JSDoc.
    expect(_accessCacheSize()).toBe(0);
  });

  it('env-vars-changed flushes the env-var snapshot cache', async () => {
    await getDb().query(
      `INSERT INTO env_vars (key, value, description, created_by) VALUES ($1, $2, $3, $4)`,
      ['FOO', encrypt('bar', process.env.ENV_SECRET_KEY!), null, 'admin']
    );
    expect(await getAllEnvVarValues()).toEqual({ FOO: 'bar' }); // primes cache

    // Insert a second row without flushing — cached snapshot should NOT see it.
    await getDb().query(
      `INSERT INTO env_vars (key, value, description, created_by) VALUES ($1, $2, $3, $4)`,
      ['BAZ', encrypt('qux', process.env.ENV_SECRET_KEY!), null, 'admin']
    );
    expect(await getAllEnvVarValues()).toEqual({ FOO: 'bar' });

    const handled = dispatchCacheEvent({ type: 'env-vars-changed' } as AgentEvent);
    expect(handled).toBe(true);
    expect(await getAllEnvVarValues()).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns false for unrelated event types so the runner switch can keep handling them', () => {
    const handled = dispatchCacheEvent({ type: 'reload', agentId: 'a' } as AgentEvent);
    expect(handled).toBe(false);
  });
});
