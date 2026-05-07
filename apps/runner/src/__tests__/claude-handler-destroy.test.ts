/**
 * @fileoverview Tests for ClaudeHandler.destroy shutdown semantics.
 *
 * Covers the bug where a wedged Claude SDK subprocess survives stopAgent /
 * reload because destroy() only cleared the session cache without aborting
 * in-flight queries. After the fix, destroy() aborts every registered
 * AbortController and (best-effort) reaps orphan subprocesses by env var.
 *
 * @module runner/__tests__/claude-handler-destroy.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeHandler } from '../claude-handler.js';
import type { Agent } from '@slackhive/shared';

vi.mock('../db.js', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  upsertSession: vi.fn().mockResolvedValue(undefined),
  cleanupStaleSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('../process-utils.js', () => ({
  findProcessesByEnv: vi.fn().mockReturnValue([]),
  killProcessesGracefully: vi.fn().mockResolvedValue(undefined),
}));

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-destroy',
    name: 'Destroy Agent',
    slug: 'destroy-agent',
    description: '',
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    slackSigningSecret: 'secret',
    model: 'claude-opus-4-6',
    status: 'stopped',
    enabled: true,
    isBoss: false,
    verbose: true,
    reportsTo: [],
    claudeMd: '',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClaudeHandler.destroy', () => {
  it('aborts every in-flight AbortController registered via streamQuery', async () => {
    const handler = new ClaudeHandler(makeAgent(), [], null, '/tmp/destroy-test', {});
    const a = new AbortController();
    const b = new AbortController();
    // Register directly — avoids spinning up the SDK in a unit test
    (handler as any).inflightAborts.add(a);
    (handler as any).inflightAborts.add(b);

    await handler.destroy();

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect((handler as any).inflightAborts.size).toBe(0);
  });

  it('looks for orphan subprocesses by AGENT_SLUG and force-kills them', async () => {
    const procUtils = await import('../process-utils.js');
    vi.mocked(procUtils.findProcessesByEnv).mockReturnValue([12345, 67890]);

    const handler = new ClaudeHandler(makeAgent({ slug: 'wedged-bot' }), [], null, '/tmp/destroy-test', {});
    await handler.destroy();

    expect(procUtils.findProcessesByEnv).toHaveBeenCalledWith('AGENT_SLUG', 'wedged-bot');
    expect(procUtils.killProcessesGracefully).toHaveBeenCalledWith(
      [12345, 67890],
      expect.any(Number),
      expect.anything(),
    );
  });

  it('does not call the killer when no orphans are found', async () => {
    const procUtils = await import('../process-utils.js');
    vi.mocked(procUtils.findProcessesByEnv).mockReturnValue([]);

    const handler = new ClaudeHandler(makeAgent(), [], null, '/tmp/destroy-test', {});
    await handler.destroy();

    expect(procUtils.killProcessesGracefully).not.toHaveBeenCalled();
  });

  it('still tears down MCP proxies even if abort throws', async () => {
    const handler = new ClaudeHandler(makeAgent(), [], null, '/tmp/destroy-test', {});
    const stopAll = vi.fn().mockResolvedValue(undefined);
    (handler as any).mcpManager.stopAll = stopAll;

    const evil = { abort: () => { throw new Error('boom'); }, signal: new AbortController().signal } as unknown as AbortController;
    (handler as any).inflightAborts.add(evil);

    await expect(handler.destroy()).resolves.not.toThrow();
    expect(stopAll).toHaveBeenCalled();
  });
});
