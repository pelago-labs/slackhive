/**
 * @fileoverview Tests for the platform-level "Open to Workspace" access gate.
 *
 * The gate lives in MessageHandler.computeUserCanTrigger and reads the
 * `openToWorkspace` key from the settings table:
 *
 * - Not set (null) → treated as true (open by default — no restriction)
 * - 'true'         → open, any Slack user passes
 * - 'false'        → restricted; fall through to per-user DB check
 *
 * We use a real SQLite DB (same pattern as cache-event-dispatch.test.ts).
 * `platform: 'slack'` on the message forces the full access-check path
 * (platform: 'test' bypasses it).
 *
 * For tests where access is DENIED: the handler calls postMessage with the
 * denial reason and returns early — no further DB/SDK calls needed.
 *
 * For tests where access is ALLOWED: the handler proceeds to getSessionKey;
 * we stub that so it returns without touching the SDK or DB.
 *
 * @module runner/__tests__/open-to-workspace
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSqliteAdapter,
  setDb,
  closeDb,
  getDb,
  type Agent,
  type IncomingMessage,
  type PlatformAdapter,
} from '@slackhive/shared';
import { MessageHandler, _resetOpenToWorkspaceCache } from '../message-handler';
import type { ClaudeHandler } from '../claude-handler';
import { _resetAccessCache } from '../access-cache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandler() {
  const adapter = makeAdapter();
  const handler = new MessageHandler(adapter, makeClaudeHandler(), makeAgent(), null);
  return { adapter, handler };
}

function makeAdapter(): PlatformAdapter {
  return {
    platform: 'slack',
    formattingRules: '',
    postMessage: vi.fn(async () => 'msg-id'),
    postPayload: vi.fn(async () => 'msg-id'),
    updateMessage: vi.fn(async () => undefined),
    postReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    swapReaction: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => []),
    getUserDisplayName: vi.fn(async () => 'tester'),
    downloadFile: vi.fn(async () => null),
    resolveLinkedMessage: vi.fn(async () => null),
    buildPayloads: vi.fn((text: string) => [{ text }]),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as PlatformAdapter;
}

/**
 * ClaudeHandler stub. getSessionKey returns immediately so the "allowed" path
 * in handleMessage proceeds past the access check without needing a real SDK.
 * streamQuery throws to halt processing before any DB writes (tasks, activity).
 */
function makeClaudeHandler(): ClaudeHandler {
  return {
    getSessionKey: vi.fn(() => 'session-key'),
    streamQuery: vi.fn(async function* () { throw new Error('halted-in-test'); }),
    destroy: vi.fn(),
  } as unknown as ClaudeHandler;
}

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    slug: 'test-agent',
    name: 'TestAgent',
    persona: null,
    description: null,
    model: 'claude-sonnet-4-6',
    status: 'running',
    enabled: true,
    isBoss: false,
    verbose: false,
    reportsTo: [],
    tags: [],
    claudeMd: '',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    slackBotToken: 'xoxb-test',
    slackAppToken: '',
    slackSigningSecret: '',
  } as unknown as Agent;
}

function makeMsg(slackUserId: string): IncomingMessage {
  return {
    id: 'msg-1',
    platform: 'slack',
    userId: slackUserId,
    channelId: 'C001',
    text: 'hello',
    threadId: undefined,
    files: [],
    raw: {},
  };
}

async function setSetting(key: string, value: string) {
  await getDb().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

async function insertUser(slackUserId: string, role = 'viewer'): Promise<string> {
  const username = `user-${slackUserId}`;
  await getDb().query(
    `INSERT INTO users (id, username, password_hash, role, slack_user_id)
     VALUES ($1, $2, 'hash', $3, $4)`,
    [`${username}-id`, username, role, slackUserId],
  );
  return username;
}

async function insertAgent() {
  await getDb().query(
    `INSERT INTO agents (id, slug, name, model, status, enabled, is_boss, verbose, reports_to, claude_md, created_by)
     VALUES ('agent-1', 'test-agent', 'TestAgent', 'claude-sonnet-4-6', 'running', 1, 0, 0, '[]', '', 'system')
     ON CONFLICT DO NOTHING`,
    [],
  );
}

async function grantAccess(slackUserId: string, level = 'trigger') {
  await insertAgent();
  const username = `user-${slackUserId}`;
  await getDb().query(
    `INSERT INTO agent_access (agent_id, user_id, access_level)
     VALUES ('agent-1', (SELECT id FROM users WHERE username = $1), $2)
     ON CONFLICT DO NOTHING`,
    [username, level],
  );
}

/** Returns all denial messages posted by the adapter. */
function denialMessages(adapter: PlatformAdapter): string[] {
  return (adapter.postMessage as ReturnType<typeof vi.fn>).mock.calls
    .map(([, text]: [string, string]) => text as string)
    .filter((t: string) => t.includes("don't have access"));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let dbPath: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-workspace-'));
  dbPath = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
  _resetAccessCache();
  _resetOpenToWorkspaceCache();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('openToWorkspace access gate', () => {
  describe('setting not configured (default open)', () => {
    it('allows any unknown Slack user when setting is absent', async () => {
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_UNKNOWN'));
      expect(denialMessages(adapter)).toHaveLength(0);
    });
  });

  describe('openToWorkspace = "true"', () => {
    it('allows a user not in SlackHive at all', async () => {
      await setSetting('openToWorkspace', 'true');
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_NOT_IN_DB'));
      expect(denialMessages(adapter)).toHaveLength(0);
    });

    it('allows an imported user with no grant', async () => {
      await setSetting('openToWorkspace', 'true');
      await insertUser('U_IMPORTED');
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_IMPORTED'));
      expect(denialMessages(adapter)).toHaveLength(0);
    });
  });

  describe('openToWorkspace = "false" (restricted)', () => {
    it('blocks a Slack user not in SlackHive', async () => {
      await setSetting('openToWorkspace', 'false');
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_UNKNOWN'));
      expect(denialMessages(adapter).length).toBeGreaterThan(0);
    });

    it('tells unknown user they need to be added to SlackHive first', async () => {
      await setSetting('openToWorkspace', 'false');
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_UNKNOWN'));
      const msgs = (adapter.postMessage as ReturnType<typeof vi.fn>).mock.calls
        .map(([, text]: [string, string]) => text as string);
      expect(msgs.some(m => m.includes('added as a user first'))).toBe(true);
    });

    it('blocks imported user without any access grant', async () => {
      await setSetting('openToWorkspace', 'false');
      await insertUser('U_IMPORTED');
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_IMPORTED'));
      expect(denialMessages(adapter).length).toBeGreaterThan(0);
    });

    it('tells imported-but-ungrant user to ask for Trigger access', async () => {
      await setSetting('openToWorkspace', 'false');
      await insertUser('U_IMPORTED');
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_IMPORTED'));
      const msgs = (adapter.postMessage as ReturnType<typeof vi.fn>).mock.calls
        .map(([, text]: [string, string]) => text as string);
      expect(msgs.some(m => m.includes('grant you Trigger'))).toBe(true);
    });

    it('allows admin regardless of restriction', async () => {
      await setSetting('openToWorkspace', 'false');
      await insertUser('U_ADMIN', 'admin');
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_ADMIN'));
      expect(denialMessages(adapter)).toHaveLength(0);
    });

    it('allows viewer with trigger grant on this agent', async () => {
      await setSetting('openToWorkspace', 'false');
      await insertUser('U_GRANTED');
      await grantAccess('U_GRANTED', 'trigger');
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_GRANTED'));
      expect(denialMessages(adapter)).toHaveLength(0);
    });

    it('blocks viewer whose grant is on a different agent', async () => {
      await setSetting('openToWorkspace', 'false');
      await insertUser('U_WRONG_GRANT');
      // Grant to a different agent — must not count
      await getDb().query(
        `INSERT INTO agents (id, slug, name, model, status, enabled, is_boss, verbose, reports_to, claude_md, created_by)
         VALUES ('agent-other', 'other', 'Other', 'claude-sonnet-4-6', 'running', 1, 0, 0, '[]', '', 'system')
         ON CONFLICT DO NOTHING`,
        [],
      );
      const username = `user-U_WRONG_GRANT`;
      await getDb().query(
        `INSERT INTO agent_access (agent_id, user_id, access_level)
         VALUES ('agent-other', (SELECT id FROM users WHERE username = $1), 'trigger')
         ON CONFLICT DO NOTHING`,
        [username],
      );
      const { adapter, handler } = makeHandler();
      await handler.handleMessage(makeMsg('U_WRONG_GRANT'));
      expect(denialMessages(adapter).length).toBeGreaterThan(0);
    });
  });
});
