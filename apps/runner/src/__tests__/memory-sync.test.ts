/**
 * @fileoverview Unit tests for ClaudeHandler.syncSessionMemories.
 *
 * Tests cover:
 * - Valid memory file with correct frontmatter is upserted to DB
 * - MEMORY.md index file is skipped
 * - File with missing/invalid frontmatter is skipped (no DB call)
 * - Non-.md files are skipped
 * - Non-existent memory dir is handled gracefully (no error)
 * - Multiple memory files are all synced
 *
 * @module runner/__tests__/memory-sync.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeHandler } from '../claude-handler.js';
import type { Agent } from '@slackhive/shared';

// ─── Mock db module ───────────────────────────────────────────────────────────

vi.mock('../db.js', () => ({
  getPool: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn().mockResolvedValue(undefined),
  cleanupStaleSessions: vi.fn().mockResolvedValue(0),
  upsertMemorySafe: vi.fn().mockResolvedValue(undefined),
}));

// Grab the mock after module resolution
import * as dbModule from '../db.js';
const mockUpsertMemorySafe = dbModule.upsertMemorySafe as ReturnType<typeof vi.fn>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(): Agent {
  return {
    id: 'agent-mem-test',
    name: 'Memory Test Agent',
    slug: 'mem-test',
    description: '',
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    slackSigningSecret: 'secret',
    model: 'claude-opus-4-6',
    status: 'stopped',
    enabled: true,
    isBoss: false,
    reportsTo: [],
    claudeMd: '',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function validMemoryContent(name: string, type = 'feedback'): string {
  return `---\nname: ${name}\ndescription: test memory\ntype: ${type}\n---\n\nMemory content here.`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('syncSessionMemories', () => {
  let tmpDir: string;
  let memDir: string;
  let handler: ClaudeHandler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sync-test-'));
    memDir = path.join(tmpDir, '.claude', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    handler = new ClaudeHandler(makeAgent(), [], null, tmpDir);
    mockUpsertMemorySafe.mockClear();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upserts a valid memory file to the database', async () => {
    fs.writeFileSync(path.join(memDir, 'feedback_test.md'), validMemoryContent('prefer_short_answers'));

    await (handler as any).syncSessionMemories(tmpDir);

    expect(mockUpsertMemorySafe).toHaveBeenCalledOnce();
    expect(mockUpsertMemorySafe).toHaveBeenCalledWith(
      'agent-mem-test',
      'feedback',
      'prefer_short_answers',
      expect.stringContaining('Memory content here.')
    );
  });

  it('skips MEMORY.md index file', async () => {
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [test](test.md) — test entry');

    await (handler as any).syncSessionMemories(tmpDir);

    expect(mockUpsertMemorySafe).not.toHaveBeenCalled();
  });

  it('skips files with missing frontmatter', async () => {
    fs.writeFileSync(path.join(memDir, 'no_frontmatter.md'), 'Just plain content, no frontmatter.');

    await (handler as any).syncSessionMemories(tmpDir);

    expect(mockUpsertMemorySafe).not.toHaveBeenCalled();
  });

  it('skips files with invalid type in frontmatter', async () => {
    const content = '---\nname: test\ntype: invalid_type\n---\n\nContent.';
    fs.writeFileSync(path.join(memDir, 'bad_type.md'), content);

    await (handler as any).syncSessionMemories(tmpDir);

    expect(mockUpsertMemorySafe).not.toHaveBeenCalled();
  });

  it('skips non-.md files', async () => {
    fs.writeFileSync(path.join(memDir, 'notes.txt'), validMemoryContent('notes'));

    await (handler as any).syncSessionMemories(tmpDir);

    expect(mockUpsertMemorySafe).not.toHaveBeenCalled();
  });

  it('handles non-existent memory directory gracefully', async () => {
    const nonExistentDir = path.join(os.tmpdir(), 'does-not-exist-' + Date.now());

    await expect((handler as any).syncSessionMemories(nonExistentDir)).resolves.toBeUndefined();
    expect(mockUpsertMemorySafe).not.toHaveBeenCalled();
  });

  it('syncs multiple memory files in one pass', async () => {
    fs.writeFileSync(path.join(memDir, 'user_role.md'), validMemoryContent('user_role', 'user'));
    fs.writeFileSync(path.join(memDir, 'feedback_style.md'), validMemoryContent('prefer_concise', 'feedback'));
    fs.writeFileSync(path.join(memDir, 'project_context.md'), validMemoryContent('current_sprint', 'project'));

    await (handler as any).syncSessionMemories(tmpDir);

    expect(mockUpsertMemorySafe).toHaveBeenCalledTimes(3);
    const calledNames = mockUpsertMemorySafe.mock.calls.map((c: unknown[]) => c[2]);
    expect(calledNames).toContain('user_role');
    expect(calledNames).toContain('prefer_concise');
    expect(calledNames).toContain('current_sprint');
  });

  it('continues syncing remaining files if one fails', async () => {
    mockUpsertMemorySafe
      .mockRejectedValueOnce(new Error('DB connection error'))
      .mockResolvedValue(undefined);

    fs.writeFileSync(path.join(memDir, 'first.md'), validMemoryContent('first', 'user'));
    fs.writeFileSync(path.join(memDir, 'second.md'), validMemoryContent('second', 'feedback'));

    await expect((handler as any).syncSessionMemories(tmpDir)).resolves.toBeUndefined();
    expect(mockUpsertMemorySafe).toHaveBeenCalledTimes(2);
  });
});
