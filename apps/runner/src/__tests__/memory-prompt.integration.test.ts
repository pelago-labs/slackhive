/**
 * @fileoverview Integration tests for the per-turn MEMORY injection layer.
 *
 * The #4 refactor moved ALL memory injection to a single per-turn layer in
 * MessageHandler.buildPrompt (no more CLAUDE.md memory cache). The selectForPrompt
 * unit tests cover the selection math in isolation; THIS suite covers the wiring:
 * a real MessageHandler runs against a real SQLite DB, seeded with memories at
 * different scopes, and we capture the prompt handed to ClaudeHandler.streamQuery.
 *
 * Asserts, from a real sender's identity:
 *   1. A global memory is injected under "# Learned Memories" for any sender.
 *   2. A memory scoped to user A reaches A but NEVER leaks to user B in the same
 *      channel (the contextual-hacking defense, enforced at the injection layer).
 *   3. A group-scoped memory reaches a group MEMBER (exercising the real
 *      users→agent_group_members→agent_groups join that resolves senderGroupIds)
 *      but not a non-member.
 *   4. A pinned memory is always present.
 *   5. No memories → no "# Learned Memories" block at all.
 *   6. Memories on a DIFFERENT agent don't bleed into this agent's prompt.
 *
 * @module runner/__tests__/memory-prompt.integration.test
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
} from '@slackhive/shared';
import { MessageHandler } from '../message-handler';
import { upsertMemory, type MemoryTierOpts } from '../db';
import type { ClaudeHandler } from '../claude-handler';

// ─── Fixtures (mirrors audience-prompt.integration.test.ts) ──────────────────

let dbPath: string;
let capturedPrompt: string | unknown[] | null = null;

function makeAdapter(): PlatformAdapter {
  return {
    platform: 'slack',
    formattingRules: '',
    postMessage: vi.fn(async () => 'msg-id'),
    postPayload: vi.fn(async () => 'msg-id'),
    updateMessage: vi.fn(async () => undefined),
    postReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => []),
    getUserDisplayName: vi.fn(async () => 'Tester'),
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
    streamQuery: vi.fn(async function* (prompt: string | unknown[]) {
      capturedPrompt = prompt;
      return;
    }),
  } as unknown as ClaudeHandler;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
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
    ...overrides,
  } as Agent;
}

function makeMsg(opts: { userId: string; text?: string }): IncomingMessage {
  return {
    id: 'msg-1',
    platform: 'slack',
    userId: opts.userId,
    channelId: 'C_chan',
    threadId: undefined,
    text: opts.text ?? 'hello',
    isDM: false,
    raw: { client: {}, messageTs: 'msg-1' },
  } as unknown as IncomingMessage;
}

async function seedAgent(id: string): Promise<void> {
  await getDb().query(
    `INSERT INTO agents (id, slug, name, model, verbose, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, id, 'Test Agent', 'claude-sonnet-4-6', 0, 'admin']
  );
}

async function seedAdminUser(slackUserId: string): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO users (id, username, password_hash, role, slack_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `user-${id.slice(0, 6)}`, null, 'admin', slackUserId]
  );
  return id;
}

async function seedGroup(agentId: string, name: string): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO agent_groups (id, agent_id, name, description, instructions, priority, verbose)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, agentId, name, null, '', 100, 0]
  );
  return id;
}

async function addMember(groupId: string, userId: string): Promise<void> {
  await getDb().query(
    `INSERT INTO agent_group_members (group_id, user_id) VALUES ($1, $2)`,
    [groupId, userId]
  );
}

/** Seed a memory on an agent with an explicit scope/pin. */
async function seedMemory(
  agentId: string,
  name: string,
  content: string,
  opts: MemoryTierOpts = {}
): Promise<void> {
  await upsertMemory(agentId, 'reference', name, content, opts);
}

async function runAndCapture(agent: Agent, userSlackId: string): Promise<string> {
  capturedPrompt = null;
  const adapter = makeAdapter();
  const claude = makeClaude();
  const handler = new MessageHandler(adapter, claude, agent, null);
  await handler.handleMessage(makeMsg({ userId: userSlackId, text: 'what is up' }));
  expect(typeof capturedPrompt === 'string').toBe(true);
  return capturedPrompt as string;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-prompt-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  vi.restoreAllMocks();
});

const MEM_HEADER = '# Learned Memories';
const MEM_INTRO = 'Facts and rules you have learned in prior conversations';

// ─── Global memories ─────────────────────────────────────────────────────────

describe('per-turn memory injection: globals', () => {
  it('injects a global memory under the Learned Memories header for any sender', async () => {
    await seedAgent('agent-1');
    await seedAdminUser('U_ANY');
    await seedMemory('agent-1', 'gmv-rule', 'GMV excludes cancelled bookings.');

    const prompt = await runAndCapture(makeAgent(), 'U_ANY');
    expect(prompt).toContain(MEM_HEADER);
    expect(prompt).toContain(MEM_INTRO);
    expect(prompt).toContain('### gmv-rule');
    expect(prompt).toContain('GMV excludes cancelled bookings.');
  });

  it('no memories → no Learned Memories block at all', async () => {
    await seedAgent('agent-1');
    await seedAdminUser('U_ANY');

    const prompt = await runAndCapture(makeAgent(), 'U_ANY');
    expect(prompt).not.toContain(MEM_HEADER);
  });
});

// ─── User scoping — the contextual-hacking defense ───────────────────────────

describe('per-turn memory injection: user scope', () => {
  it('a memory scoped to user A reaches A but NEVER leaks to user B', async () => {
    await seedAgent('agent-1');
    await seedAdminUser('U_ALICE');
    await seedAdminUser('U_BOB');
    // Scope is keyed by slack_user_id (what selectForPrompt compares against userId).
    await seedMemory('agent-1', 'alice-pref', 'Alice prefers terse one-line answers.', {
      scopeUserId: 'U_ALICE',
    });

    const forAlice = await runAndCapture(makeAgent(), 'U_ALICE');
    expect(forAlice).toContain('### alice-pref');
    expect(forAlice).toContain('Alice prefers terse one-line answers.');

    const forBob = await runAndCapture(makeAgent(), 'U_BOB');
    // Bob must not see Alice's private memory, and with nothing else scoped/global
    // there should be no memory block for Bob at all.
    expect(forBob).not.toContain('alice-pref');
    expect(forBob).not.toContain('Alice prefers terse one-line answers.');
    expect(forBob).not.toContain(MEM_HEADER);
  });

  it('a global memory is shared while a user-scoped one stays private (mixed set)', async () => {
    await seedAgent('agent-1');
    await seedAdminUser('U_ALICE');
    await seedAdminUser('U_BOB');
    await seedMemory('agent-1', 'shared-fact', 'The fiscal year starts in April.');
    await seedMemory('agent-1', 'alice-only', 'Alice sits in the Singapore office.', {
      scopeUserId: 'U_ALICE',
    });

    const forBob = await runAndCapture(makeAgent(), 'U_BOB');
    expect(forBob).toContain('### shared-fact');       // global reaches Bob
    expect(forBob).not.toContain('alice-only');        // Alice's stays private
    expect(forBob).not.toContain('Singapore office');
  });
});

// ─── Group scoping — exercises the real DB join for senderGroupIds ───────────

describe('per-turn memory injection: group scope', () => {
  it('a group-scoped memory reaches a member but not a non-member', async () => {
    await seedAgent('agent-1');
    const aliceId = await seedAdminUser('U_ALICE');
    await seedAdminUser('U_OUTSIDER');
    const execs = await seedGroup('agent-1', 'execs');
    await addMember(execs, aliceId);
    await seedMemory('agent-1', 'exec-brief', 'Execs get revenue in SGD millions.', {
      scopeGroupId: execs,
    });

    const forMember = await runAndCapture(makeAgent(), 'U_ALICE');
    expect(forMember).toContain('### exec-brief');
    expect(forMember).toContain('Execs get revenue in SGD millions.');

    const forOutsider = await runAndCapture(makeAgent(), 'U_OUTSIDER');
    expect(forOutsider).not.toContain('exec-brief');
    expect(forOutsider).not.toContain(MEM_HEADER);
  });
});

// ─── Pinned tier ─────────────────────────────────────────────────────────────

describe('per-turn memory injection: pinned', () => {
  it('a pinned global memory is always injected', async () => {
    await seedAgent('agent-1');
    await seedAdminUser('U_ANY');
    await seedMemory('agent-1', 'house-rule', 'Never post before 9am local.', { pinned: true });

    const prompt = await runAndCapture(makeAgent(), 'U_ANY');
    expect(prompt).toContain('### house-rule');
    expect(prompt).toContain('Never post before 9am local.');
  });
});

// ─── Cross-agent isolation ───────────────────────────────────────────────────

describe('per-turn memory injection: cross-agent isolation', () => {
  it("memories on agent B do not bleed into agent A's prompt", async () => {
    await seedAgent('agent-A');
    await seedAgent('agent-B');
    await seedAdminUser('U_ANY');
    await seedMemory('agent-B', 'b-only', 'This belongs to agent B alone.');

    const prompt = await runAndCapture(makeAgent({ id: 'agent-A', slug: 'agent-A' }), 'U_ANY');
    expect(prompt).not.toContain('b-only');
    expect(prompt).not.toContain('This belongs to agent B alone.');
    expect(prompt).not.toContain(MEM_HEADER);
  });
});
