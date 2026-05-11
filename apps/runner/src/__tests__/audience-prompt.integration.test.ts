/**
 * @fileoverview Integration tests for audience-driven prompt construction.
 *
 * Runs a real MessageHandler against a real SQLite DB and captures the
 * prompt that's handed to ClaudeHandler.streamQuery. Asserts:
 *
 *   1. Audience free-text instructions land in the per-message prompt
 *      under "[Audience guidance for this sender]" for matching senders,
 *      and stay absent for non-members.
 *
 *   2. The verbose narration directive ("# Share your direction") is
 *      injected per-sender based on the resolved verbose state — audience
 *      wins over agent. All four agent × audience cells of the matrix.
 *
 *   3. When a member is in multiple audiences with conflicting verbose
 *      flags, the highest-priority group (priority ASC, name ASC) wins.
 *
 *   4. An audience on a DIFFERENT agent doesn't bleed into this agent's
 *      prompt for the same sender.
 *
 * @module runner/__tests__/audience-prompt.integration.test
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
import type { ClaudeHandler } from '../claude-handler';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
    // Capture the prompt the message handler hands us — that's what we assert
    // on. Yield nothing so handleMessage's outer for-await completes cleanly.
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
    persona: undefined,
    description: undefined,
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

async function seedAgent(id: string, opts: { verbose?: boolean } = {}): Promise<void> {
  await getDb().query(
    `INSERT INTO agents (id, slug, name, model, verbose, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, id, 'Test Agent', 'claude-sonnet-4-6', opts.verbose ? 1 : 0, 'admin']
  );
}

/**
 * Seeds an admin user (so userCanTrigger passes without extra setup).
 * `slackUserId` is the Slack U… ID we'll send messages from.
 */
async function seedAdminUser(slackUserId: string): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO users (id, username, password_hash, role, slack_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `user-${id.slice(0, 6)}`, null, 'admin', slackUserId]
  );
  return id;
}

async function seedGroup(opts: {
  agentId: string;
  name: string;
  priority?: number;
  verbose?: boolean;
  instructions?: string;
}): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO agent_groups (id, agent_id, name, description, instructions, priority, verbose)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, opts.agentId, opts.name, null, opts.instructions ?? '', opts.priority ?? 100, opts.verbose ? 1 : 0]
  );
  return id;
}

async function addMember(groupId: string, userId: string): Promise<void> {
  await getDb().query(
    `INSERT INTO agent_group_members (group_id, user_id) VALUES ($1, $2)`,
    [groupId, userId]
  );
}

/** Run a single inbound message through MessageHandler and return the captured prompt as a string. */
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audience-prompt-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  vi.restoreAllMocks();
});

const VERBOSE_MARKER = '# Share your direction (verbose mode)';
const AUDIENCE_HEADER = '[Audience guidance for this sender]';

// ─── Verbose resolution matrix (no audience) ────────────────────────────────

describe('verbose: no-audience baseline', () => {
  it('agent.verbose=false → no verbose directive', async () => {
    await seedAgent('agent-1', { verbose: false });
    await seedAdminUser('U_NOAUD');
    const prompt = await runAndCapture(makeAgent({ verbose: false }), 'U_NOAUD');
    expect(prompt).not.toContain(VERBOSE_MARKER);
    expect(prompt).not.toContain(AUDIENCE_HEADER);
    expect(prompt).not.toContain('· groups:');
  });

  it('agent.verbose=true → verbose directive present', async () => {
    await seedAgent('agent-1', { verbose: true });
    await seedAdminUser('U_NOAUD');
    const prompt = await runAndCapture(makeAgent({ verbose: true }), 'U_NOAUD');
    expect(prompt).toContain(VERBOSE_MARKER);
    expect(prompt).not.toContain(AUDIENCE_HEADER);
  });
});

// ─── Audience overrides agent verbose ───────────────────────────────────────

describe('verbose: audience override', () => {
  it('agent off + audience.verbose=true → verbose directive INJECTED for the member', async () => {
    await seedAgent('agent-1', { verbose: false });
    const userId = await seedAdminUser('U_MEMBER');
    const groupId = await seedGroup({ agentId: 'agent-1', name: 'execs', verbose: true });
    await addMember(groupId, userId);

    const prompt = await runAndCapture(makeAgent({ verbose: false }), 'U_MEMBER');
    expect(prompt).toContain(VERBOSE_MARKER);
    // Group with empty instructions and verbose-only override: groups listed
    // in sender header but no audience-instructions block emitted.
    expect(prompt).toContain('· groups: execs');
    expect(prompt).not.toContain(AUDIENCE_HEADER);
  });

  it('agent on + audience.verbose=false → verbose directive SUPPRESSED for the member', async () => {
    await seedAgent('agent-1', { verbose: true });
    const userId = await seedAdminUser('U_MEMBER');
    const groupId = await seedGroup({ agentId: 'agent-1', name: 'execs', verbose: false });
    await addMember(groupId, userId);

    const prompt = await runAndCapture(makeAgent({ verbose: true }), 'U_MEMBER');
    expect(prompt).not.toContain(VERBOSE_MARKER);
    expect(prompt).toContain('· groups: execs');
  });

  it('agent on + audience.verbose=true → verbose directive present (same as either-alone)', async () => {
    await seedAgent('agent-1', { verbose: true });
    const userId = await seedAdminUser('U_MEMBER');
    const groupId = await seedGroup({ agentId: 'agent-1', name: 'execs', verbose: true });
    await addMember(groupId, userId);

    const prompt = await runAndCapture(makeAgent({ verbose: true }), 'U_MEMBER');
    expect(prompt).toContain(VERBOSE_MARKER);
    // Directive should only appear ONCE in the prompt — no double-inject.
    expect(prompt.split(VERBOSE_MARKER).length - 1).toBe(1);
  });

  it('agent off + audience.verbose=false → no verbose directive', async () => {
    await seedAgent('agent-1', { verbose: false });
    const userId = await seedAdminUser('U_MEMBER');
    const groupId = await seedGroup({ agentId: 'agent-1', name: 'execs', verbose: false });
    await addMember(groupId, userId);

    const prompt = await runAndCapture(makeAgent({ verbose: false }), 'U_MEMBER');
    expect(prompt).not.toContain(VERBOSE_MARKER);
  });
});

// ─── Audience instructions ──────────────────────────────────────────────────

describe('audience instructions', () => {
  it('non-empty instructions land in the audience block', async () => {
    await seedAgent('agent-1');
    const userId = await seedAdminUser('U_MEMBER');
    const groupId = await seedGroup({
      agentId: 'agent-1',
      name: 'Marketing',
      instructions: 'Keep replies under 3 sentences. Avoid jargon.',
    });
    await addMember(groupId, userId);

    const prompt = await runAndCapture(makeAgent(), 'U_MEMBER');
    expect(prompt).toContain(AUDIENCE_HEADER);
    expect(prompt).toContain('- (Marketing) Keep replies under 3 sentences. Avoid jargon.');
    expect(prompt).toContain('· groups: Marketing');
  });

  it('empty instructions on a verbose-only group → no audience block, no bullet', async () => {
    await seedAgent('agent-1');
    const userId = await seedAdminUser('U_MEMBER');
    const groupId = await seedGroup({ agentId: 'agent-1', name: 'execs', verbose: true });
    await addMember(groupId, userId);

    const prompt = await runAndCapture(makeAgent(), 'U_MEMBER');
    expect(prompt).not.toContain(AUDIENCE_HEADER);
    expect(prompt).toContain('· groups: execs');
  });

  it('non-member: instructions and verbose directive both absent', async () => {
    await seedAgent('agent-1');
    await seedAdminUser('U_NONMEMBER');
    // Group exists but the user is not a member.
    await seedGroup({ agentId: 'agent-1', name: 'Marketing', verbose: true, instructions: 'be brief' });

    const prompt = await runAndCapture(makeAgent(), 'U_NONMEMBER');
    expect(prompt).not.toContain(AUDIENCE_HEADER);
    expect(prompt).not.toContain(VERBOSE_MARKER);
    expect(prompt).not.toContain('· groups:');
  });

  it('two groups → instructions concatenated in priority order', async () => {
    await seedAgent('agent-1');
    const userId = await seedAdminUser('U_MEMBER');
    const g1 = await seedGroup({ agentId: 'agent-1', name: 'High', priority: 10, instructions: 'first rule' });
    const g2 = await seedGroup({ agentId: 'agent-1', name: 'Low', priority: 50, instructions: 'second rule' });
    await addMember(g1, userId);
    await addMember(g2, userId);

    const prompt = await runAndCapture(makeAgent(), 'U_MEMBER');
    const firstIdx = prompt.indexOf('- (High) first rule');
    const secondIdx = prompt.indexOf('- (Low) second rule');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

// ─── Multi-group verbose resolution ─────────────────────────────────────────

describe('verbose: multi-group resolution', () => {
  it('highest-priority group wins when verbose values conflict (10:on > 100:off → on)', async () => {
    await seedAgent('agent-1', { verbose: false });
    const userId = await seedAdminUser('U_MEMBER');
    const gOn = await seedGroup({ agentId: 'agent-1', name: 'fast-track', priority: 10, verbose: true });
    const gOff = await seedGroup({ agentId: 'agent-1', name: 'default-pool', priority: 100, verbose: false });
    await addMember(gOn, userId);
    await addMember(gOff, userId);

    const prompt = await runAndCapture(makeAgent({ verbose: false }), 'U_MEMBER');
    expect(prompt).toContain(VERBOSE_MARKER);
  });

  it('highest-priority group wins when verbose values conflict (5:off > 100:on → off)', async () => {
    await seedAgent('agent-1', { verbose: true });
    const userId = await seedAdminUser('U_MEMBER');
    const gOff = await seedGroup({ agentId: 'agent-1', name: 'quiet-mode', priority: 5, verbose: false });
    const gOn = await seedGroup({ agentId: 'agent-1', name: 'general', priority: 100, verbose: true });
    await addMember(gOff, userId);
    await addMember(gOn, userId);

    const prompt = await runAndCapture(makeAgent({ verbose: true }), 'U_MEMBER');
    expect(prompt).not.toContain(VERBOSE_MARKER);
  });
});

// ─── Cross-agent isolation ──────────────────────────────────────────────────

describe('cross-agent isolation', () => {
  it("audience on agent B doesn't bleed into agent A's prompt for the same sender", async () => {
    // Seed two agents. The user is a member of a verbose+instruction group
    // on agent B, but messages agent A.
    await seedAgent('agent-A', { verbose: false });
    await seedAgent('agent-B', { verbose: false });
    const userId = await seedAdminUser('U_MEMBER');
    const groupOnB = await seedGroup({
      agentId: 'agent-B',
      name: 'OnlyB',
      verbose: true,
      instructions: 'B-only style',
    });
    await addMember(groupOnB, userId);

    // Send to agent A.
    const prompt = await runAndCapture(
      makeAgent({ id: 'agent-A', slug: 'agent-A', verbose: false }),
      'U_MEMBER'
    );
    expect(prompt).not.toContain(VERBOSE_MARKER);
    expect(prompt).not.toContain(AUDIENCE_HEADER);
    expect(prompt).not.toContain('· groups:');
    expect(prompt).not.toContain('B-only style');
  });
});
