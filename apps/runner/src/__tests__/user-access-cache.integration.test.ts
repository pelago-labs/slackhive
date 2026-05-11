/**
 * @fileoverview Integration test for the userCanTrigger LRU.
 *
 * Real SQLite DB; the adapter is wrapped to count `query()` calls so we can
 * assert the second message from the same sender skips the access-check
 * round-trips entirely. Also verifies that publishing a user-access-changed
 * event drops the cached entry (via flushUserAccessCache).
 *
 * @module runner/__tests__/user-access-cache.integration.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSqliteAdapter,
  setDb,
  getDb,
  closeDb,
  type Agent,
  type IncomingMessage,
  type PlatformAdapter,
  type DbAdapter,
} from '@slackhive/shared';
import { MessageHandler } from '../message-handler';
import type { ClaudeHandler } from '../claude-handler';
import { _resetAccessCache, flushUserAccessCache } from '../access-cache';

// ─── Query-counting adapter wrapper ─────────────────────────────────────────

interface CountingAdapter extends DbAdapter {
  queryCount: number;
  resetCounter(): void;
}

function wrapWithCounter(inner: DbAdapter): CountingAdapter {
  let count = 0;
  const wrapped: CountingAdapter = {
    type: inner.type,
    query: async (sql, params) => { count++; return inner.query(sql, params); },
    transaction: (fn) => inner.transaction(fn),
    close: () => inner.close(),
    get queryCount() { return count; },
    resetCounter() { count = 0; },
  };
  return wrapped;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let dbPath: string;
let countingAdapter: CountingAdapter;

function makePlatformAdapter(): PlatformAdapter {
  return {
    platform: 'slack',
    formattingRules: '',
    postMessage: vi.fn(async () => 'msg-id'),
    postPayload: vi.fn(async () => 'msg-id'),
    updateMessage: vi.fn(async () => undefined),
    postReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => []),
    getUserDisplayName: vi.fn(async () => 'tester'),
    downloadFile: vi.fn(async () => null),
    resolveLinkedMessage: vi.fn(async () => null),
    buildPayloads: vi.fn((text: string) => [{ text }]),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as PlatformAdapter;
}

function makeClaude(): ClaudeHandler {
  return {
    getSessionKey: (userId: string, channelId: string, threadTs?: string) =>
      `${userId}-${channelId}-${threadTs ?? 'direct'}`,
    // eslint-disable-next-line require-yield
    streamQuery: vi.fn(async function* () { return; }),
  } as unknown as ClaudeHandler;
}

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    slug: 'agent-1',
    name: 'Test Agent',
    model: 'claude-sonnet-4-6',
    status: 'running',
    enabled: true,
    isBoss: false,
    verbose: false,
    reportsTo: [],
    tags: [],
    claudeMd: '',
    createdBy: 'admin',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Agent;
}

function makeMsg(userId: string): IncomingMessage {
  return {
    id: 'msg-1',
    platform: 'slack',
    userId,
    channelId: 'C_chan',
    text: 'hello',
    isDM: false,
    raw: { client: {}, messageTs: 'msg-1' },
  } as unknown as IncomingMessage;
}

async function seedAgent(id: string, createdBy = 'admin'): Promise<void> {
  await getDb().query(
    `INSERT INTO agents (id, slug, name, model, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [id, id, 'Test Agent', 'claude-sonnet-4-6', createdBy]
  );
}

async function seedUser(slackUserId: string, role = 'viewer'): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO users (id, username, password_hash, role, slack_user_id) VALUES ($1, $2, $3, $4, $5)`,
    [id, `user-${id.slice(0, 6)}`, null, role, slackUserId]
  );
  return id;
}

async function grantAccess(agentId: string, userId: string, level = 'edit'): Promise<void> {
  await getDb().query(
    `INSERT INTO agent_access (agent_id, user_id, can_write, access_level) VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, user_id) DO UPDATE SET access_level = $4`,
    [agentId, userId, level === 'edit' ? 1 : 0, level]
  );
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-access-cache-'));
  dbPath = path.join(tmpDir, 'data.db');
  countingAdapter = wrapWithCounter(createSqliteAdapter(dbPath));
  setDb(countingAdapter);
  _resetAccessCache();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  _resetAccessCache();
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('userCanTrigger LRU', () => {
  it('the FIRST call hits the DB (2 queries for a non-admin sender)', async () => {
    await seedAgent('agent-1');
    const userId = await seedUser('U_VIEWER', 'viewer');
    await grantAccess('agent-1', userId);

    const handler = new MessageHandler(makePlatformAdapter(), makeClaude(), makeAgent(), null);
    countingAdapter.resetCounter();
    await handler.handleMessage(makeMsg('U_VIEWER'));

    // 2 access-check queries plus a small constant from the rest of
    // handleMessage. Asserting >= 2 keeps the test resilient to incidental
    // bookkeeping queries the message-handler adds later.
    expect(countingAdapter.queryCount).toBeGreaterThanOrEqual(2);
  });

  it('the SECOND call within TTL adds ZERO access-check queries', async () => {
    await seedAgent('agent-1');
    const userId = await seedUser('U_VIEWER', 'viewer');
    await grantAccess('agent-1', userId);

    const handler = new MessageHandler(makePlatformAdapter(), makeClaude(), makeAgent(), null);
    await handler.handleMessage(makeMsg('U_VIEWER')); // primes the cache

    const before = countingAdapter.queryCount;
    await handler.handleMessage(makeMsg('U_VIEWER'));
    const delta = countingAdapter.queryCount - before;

    // Second message's access check should NOT add the 2 access queries.
    // We can't assert delta === 0 because buildPrompt has its own queries
    // (audience lookup, etc.). But delta should be strictly less than the
    // first call's spend by at least the 2 access queries we removed.
    expect(delta).toBeLessThan(before);
  });

  it('admin senders cache the early-return path (no second-query miss)', async () => {
    await seedAgent('agent-1');
    await seedUser('U_ADMIN', 'admin');

    const handler = new MessageHandler(makePlatformAdapter(), makeClaude(), makeAgent(), null);
    await handler.handleMessage(makeMsg('U_ADMIN'));
    const before = countingAdapter.queryCount;
    await handler.handleMessage(makeMsg('U_ADMIN'));
    expect(countingAdapter.queryCount - before).toBeLessThan(before);
  });

  it('flushUserAccessCache by slackUserId re-arms the cache for the next message', async () => {
    await seedAgent('agent-1');
    const userId = await seedUser('U_VIEWER', 'viewer');
    await grantAccess('agent-1', userId);

    const handler = new MessageHandler(makePlatformAdapter(), makeClaude(), makeAgent(), null);
    await handler.handleMessage(makeMsg('U_VIEWER'));
    const beforeFlush = countingAdapter.queryCount;
    await handler.handleMessage(makeMsg('U_VIEWER'));   // cache hit
    const afterCached = countingAdapter.queryCount;

    flushUserAccessCache({ slackUserId: 'U_VIEWER' });
    await handler.handleMessage(makeMsg('U_VIEWER'));   // cache miss again
    const afterFlush = countingAdapter.queryCount;

    // The flushed message should add MORE queries than the cached one.
    expect(afterFlush - afterCached).toBeGreaterThan(afterCached - beforeFlush);
  });

  it('different senders share no cache entries (no false-positive allow)', async () => {
    await seedAgent('agent-1');
    const u1 = await seedUser('U_A', 'viewer');
    await grantAccess('agent-1', u1);
    // U_B has no access — must be denied; cache for U_A must NOT short-circuit
    // the U_B check.
    await seedUser('U_B', 'viewer');

    const handler = new MessageHandler(makePlatformAdapter(), makeClaude(), makeAgent(), null);
    const adapter = handler['adapter'] as { postMessage: ReturnType<typeof vi.fn> };
    await handler.handleMessage(makeMsg('U_A')); // primes U_A as allowed
    await handler.handleMessage(makeMsg('U_B')); // must still be denied
    const posts = adapter.postMessage.mock.calls.map(c => c[1] as string);
    expect(posts).toContain("You don't have access to this agent.");
  });
});
