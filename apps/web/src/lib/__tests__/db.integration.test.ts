/**
 * @fileoverview Integration tests for db.ts — requires a real Postgres connection.
 *
 * Set TEST_DATABASE_URL to run these tests. Without it, the entire suite is
 * skipped so CI (which has no DB) is not affected.
 *
 * @module web/lib/__tests__/db.integration.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Agent } from '@slackhive/shared';

// Swap DATABASE_URL for the test database before importing db functions.
// This must happen before the module is loaded so the singleton pool picks it up.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

import {
  createAgent,
  getAgentById,
  updateAgentClaudeMd,
  deleteAgent,
  upsertSkill,
  getAgentSkills,
  deleteSkill,
  createSnapshot,
  listSnapshots,
  getSnapshotById,
  deleteSnapshot,
  userCanWriteAgent,
  grantAgentWrite,
  revokeAgentWrite,
  createUser,
  deleteUser,
  getUserByUsername,
} from '@/lib/db';

const DB_AVAILABLE = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_AVAILABLE)('db integration tests', () => {

  // ---------------------------------------------------------------------------
  // createAgent + getAgentById
  // ---------------------------------------------------------------------------

  describe('createAgent + getAgentById', () => {
    let agentId: string;

    afterAll(async () => {
      if (agentId) await deleteAgent(agentId);
    });

    it('creates an agent and fetches it by id', async () => {
      const agent = await createAgent({
        slug: `test-agent-${Date.now()}`,
        name: 'Test Agent',
        persona: 'A test persona',
        description: 'Integration test agent',
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
        slackSigningSecret: 'secret',
        model: 'claude-opus-4-6',
      }, 'test-user');

      agentId = agent.id;

      expect(agent.id).toBeTruthy();
      expect(agent.slug).toMatch(/^test-agent-/);
      expect(agent.name).toBe('Test Agent');
      expect(agent.persona).toBe('A test persona');
      expect(agent.createdBy).toBe('test-user');

      const fetched = await getAgentById(agent.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(agent.id);
      expect(fetched!.name).toBe('Test Agent');
    });

    it('returns null for a non-existent agent id', async () => {
      const result = await getAgentById('00000000-0000-0000-0000-000000000000');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // updateAgentClaudeMd
  // ---------------------------------------------------------------------------

  describe('updateAgentClaudeMd', () => {
    let agentId: string;

    beforeAll(async () => {
      const agent = await createAgent({
        slug: `test-claude-md-${Date.now()}`,
        name: 'Claude MD Test',
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
        slackSigningSecret: 'secret',
      }, 'test-user');
      agentId = agent.id;
    });

    afterAll(async () => {
      if (agentId) await deleteAgent(agentId);
    });

    it('updates claudeMd and reflects the change on re-fetch', async () => {
      const newContent = '# Updated CLAUDE.md\n\nNew content here.';
      await updateAgentClaudeMd(agentId, newContent);

      const fetched = await getAgentById(agentId);
      expect(fetched!.claudeMd).toBe(newContent);
    });
  });

  // ---------------------------------------------------------------------------
  // upsertSkill + getAgentSkills + deleteSkill
  // ---------------------------------------------------------------------------

  describe('upsertSkill + getAgentSkills + deleteSkill', () => {
    let agentId: string;

    beforeAll(async () => {
      const agent = await createAgent({
        slug: `test-skills-${Date.now()}`,
        name: 'Skills Test',
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
        slackSigningSecret: 'secret',
      }, 'test-user');
      agentId = agent.id;
    });

    afterAll(async () => {
      if (agentId) await deleteAgent(agentId);
    });

    it('adds two skills and lists them in sort order', async () => {
      await upsertSkill(agentId, '00-core', 'main.md', '# Main', 0);
      await upsertSkill(agentId, '00-core', 'extra.md', '# Extra', 1);

      const skills = await getAgentSkills(agentId);
      expect(skills).toHaveLength(2);
      // Sort order: main.md (0) before extra.md (1)
      expect(skills[0].filename).toBe('main.md');
      expect(skills[1].filename).toBe('extra.md');
    });

    it('deletes one skill and leaves only one remaining', async () => {
      const skills = await getAgentSkills(agentId);
      await deleteSkill(skills[0].id);

      const remaining = await getAgentSkills(agentId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].filename).toBe('extra.md');
    });
  });

  // ---------------------------------------------------------------------------
  // createSnapshot + listSnapshots + getSnapshotById + deleteSnapshot
  // ---------------------------------------------------------------------------

  describe('snapshots', () => {
    let agentId: string;
    let snapshotId: string;

    beforeAll(async () => {
      const agent = await createAgent({
        slug: `test-snapshot-${Date.now()}`,
        name: 'Snapshot Test',
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
        slackSigningSecret: 'secret',
      }, 'test-user');
      agentId = agent.id;
    });

    afterAll(async () => {
      if (agentId) await deleteAgent(agentId);
    });

    it('creates a snapshot and it appears in listSnapshots', async () => {
      const snap = await createSnapshot(
        agentId,
        'manual',
        'test-user',
        'initial snapshot',
        [{ category: '00-core', filename: 'main.md', content: '# Main', sort_order: 0 }],
        ['Read'],
        [],
        [],
        '# Main',
      );
      snapshotId = snap.id;

      expect(snap.id).toBeTruthy();
      expect(snap.label).toBe('initial snapshot');
      expect(snap.trigger).toBe('manual');
      expect(snap.compiledMd).toBe('# Main');

      const list = await listSnapshots(agentId);
      expect(list.some(s => s.id === snap.id)).toBe(true);
    });

    it('fetches a snapshot by id', async () => {
      const fetched = await getSnapshotById(snapshotId);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(snapshotId);
      expect(fetched!.skillsJson).toHaveLength(1);
    });

    it('deletes a snapshot and it no longer appears in listSnapshots', async () => {
      await deleteSnapshot(snapshotId);
      const list = await listSnapshots(agentId);
      expect(list.some(s => s.id === snapshotId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // userCanWriteAgent + grantAgentWrite + revokeAgentWrite
  // ---------------------------------------------------------------------------

  describe('userCanWriteAgent', () => {
    let agentId: string;
    let editorUserId: string;
    const editorUsername = `test-editor-${Date.now()}`;

    beforeAll(async () => {
      const agent = await createAgent({
        slug: `test-access-${Date.now()}`,
        name: 'Access Test',
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
        slackSigningSecret: 'secret',
      }, 'system');
      agentId = agent.id;

      // Create a test editor user
      const user = await createUser(editorUsername, 'hashed-password', 'editor');
      editorUserId = user.id;
    });

    afterAll(async () => {
      if (agentId) await deleteAgent(agentId);
      if (editorUserId) await deleteUser(editorUserId);
    });

    it('returns true for admin role without a DB check', async () => {
      const result = await userCanWriteAgent(agentId, 'any-admin', 'admin');
      expect(result).toBe(true);
    });

    it('returns false for editor with no grants', async () => {
      const result = await userCanWriteAgent(agentId, editorUsername, 'editor');
      expect(result).toBe(false);
    });

    it('returns true after grantAgentWrite', async () => {
      await grantAgentWrite(agentId, editorUserId);
      const result = await userCanWriteAgent(agentId, editorUsername, 'editor');
      expect(result).toBe(true);
    });

    it('returns false after revokeAgentWrite', async () => {
      await revokeAgentWrite(agentId, editorUserId);
      const result = await userCanWriteAgent(agentId, editorUsername, 'editor');
      expect(result).toBe(false);
    });
  });
});
