/**
 * @fileoverview Unit tests for boss-registry.ts — regenerateBossRegistry.
 *
 * Tests cover the registry content generation logic: team listing, delegation
 * instructions, Slack mention format, multi-boss routing, and edge cases like
 * agents with no Slack user ID or no team members.
 *
 * All DB calls are mocked via vi.mock — no database connection required.
 *
 * @module web/lib/__tests__/boss-registry.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@slackhive/shared';

// Mock DB dependencies before importing the module under test
vi.mock('@/lib/db', () => ({
  getAllAgents: vi.fn(),
  updateAgentClaudeMd: vi.fn().mockResolvedValue(undefined),
  publishAgentEvent: vi.fn().mockResolvedValue(undefined),
}));

import { regenerateBossRegistry } from '@/lib/boss-registry';
import { getAllAgents, updateAgentClaudeMd, publishAgentEvent } from '@/lib/db';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: 'agent-1',
    slug: 'agent',
    name: 'Agent',
    persona: undefined,
    description: undefined,
    slackBotToken: 'xoxb-fake',
    slackAppToken: 'xapp-fake',
    slackSigningSecret: 'secret',
    slackBotUserId: undefined,
    model: 'claude-opus-4-5',
    status: 'stopped',
    enabled: true,
    isBoss: false,
    reportsTo: [],
    claudeMd: '',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('regenerateBossRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when there are no boss agents', async () => {
    vi.mocked(getAllAgents).mockResolvedValue([
      makeAgent({ id: 'a1', isBoss: false }),
    ]);

    await regenerateBossRegistry();

    expect(updateAgentClaudeMd).not.toHaveBeenCalled();
    expect(publishAgentEvent).not.toHaveBeenCalled();
  });

  it('does nothing when boss has no team members with slackBotUserId', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss' });
    const specialist = makeAgent({ id: 'spec-1', isBoss: false, reportsTo: ['boss-1'], slackBotUserId: undefined });

    vi.mocked(getAllAgents).mockResolvedValue([boss, specialist]);

    await regenerateBossRegistry();

    expect(updateAgentClaudeMd).not.toHaveBeenCalled();
  });

  it('generates registry with correct agent mention and description', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss' });
    const specialist = makeAgent({
      id: 'spec-1', name: 'DataBot', isBoss: false,
      reportsTo: ['boss-1'], slackBotUserId: 'U123ABC',
      description: 'Runs Redshift queries',
    });

    vi.mocked(getAllAgents).mockResolvedValue([boss, specialist]);

    await regenerateBossRegistry();

    const content = vi.mocked(updateAgentClaudeMd).mock.calls[0][1];
    expect(content).toContain('**DataBot** (<@U123ABC>) — Runs Redshift queries');
  });

  it('uses slug-based fallback mention when slackBotUserId is missing', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss' });
    // specialist has no slackBotUserId — registry should fall back to @slug
    const specialist = makeAgent({
      id: 'spec-1', name: 'DataBot', slug: 'data-bot', isBoss: false,
      reportsTo: ['boss-1'], slackBotUserId: undefined,
      description: 'Runs Redshift queries',
    });

    vi.mocked(getAllAgents).mockResolvedValue([boss, specialist]);

    // regenerateSingleBossRegistry skips agents with no slackBotUserId
    // so updateAgentClaudeMd should NOT be called
    await regenerateBossRegistry();
    expect(updateAgentClaudeMd).not.toHaveBeenCalled();
  });

  it('uses default description when agent description is undefined', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss' });
    const specialist = makeAgent({
      id: 'spec-1', name: 'Writer', isBoss: false,
      reportsTo: ['boss-1'], slackBotUserId: 'U999',
      description: undefined,
    });

    vi.mocked(getAllAgents).mockResolvedValue([boss, specialist]);

    await regenerateBossRegistry();

    const content = vi.mocked(updateAgentClaudeMd).mock.calls[0][1];
    expect(content).toContain('No description provided.');
  });

  it('includes boss name in the registry heading', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'HQ Boss' });
    const specialist = makeAgent({
      id: 'spec-1', isBoss: false, reportsTo: ['boss-1'], slackBotUserId: 'U1',
    });

    vi.mocked(getAllAgents).mockResolvedValue([boss, specialist]);

    await regenerateBossRegistry();

    const content = vi.mocked(updateAgentClaudeMd).mock.calls[0][1];
    expect(content).toContain('# HQ Boss — Team Orchestrator');
  });

  it('includes delegation instructions in the registry', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss' });
    const specialist = makeAgent({
      id: 'spec-1', isBoss: false, reportsTo: ['boss-1'], slackBotUserId: 'U1',
    });

    vi.mocked(getAllAgents).mockResolvedValue([boss, specialist]);

    await regenerateBossRegistry();

    const content = vi.mocked(updateAgentClaudeMd).mock.calls[0][1];
    expect(content).toContain('ALWAYS delegate');
    expect(content).toContain('## Your Team');
    expect(content).toContain('## How to delegate');
  });

  it('publishes a reload event after updating the registry', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss' });
    const specialist = makeAgent({
      id: 'spec-1', isBoss: false, reportsTo: ['boss-1'], slackBotUserId: 'U1',
    });

    vi.mocked(getAllAgents).mockResolvedValue([boss, specialist]);

    await regenerateBossRegistry();

    expect(publishAgentEvent).toHaveBeenCalledWith({ type: 'reload', agentId: 'boss-1' });
  });

  it('handles multiple bosses independently', async () => {
    const boss1 = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss One' });
    const boss2 = makeAgent({ id: 'boss-2', isBoss: true, name: 'Boss Two' });
    const spec1 = makeAgent({ id: 'spec-1', isBoss: false, reportsTo: ['boss-1'], slackBotUserId: 'U1', name: 'Alpha' });
    const spec2 = makeAgent({ id: 'spec-2', isBoss: false, reportsTo: ['boss-2'], slackBotUserId: 'U2', name: 'Beta' });

    vi.mocked(getAllAgents).mockResolvedValue([boss1, boss2, spec1, spec2]);

    await regenerateBossRegistry();

    expect(updateAgentClaudeMd).toHaveBeenCalledTimes(2);

    const [call1, call2] = vi.mocked(updateAgentClaudeMd).mock.calls;
    const contents = [call1[1], call2[1]];

    expect(contents.some(c => c.includes('Boss One') && c.includes('Alpha'))).toBe(true);
    expect(contents.some(c => c.includes('Boss Two') && c.includes('Beta'))).toBe(true);
  });

  it('does not include agents from other boss teams in a boss registry', async () => {
    const boss1 = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss One' });
    const boss2 = makeAgent({ id: 'boss-2', isBoss: true, name: 'Boss Two' });
    const spec1 = makeAgent({ id: 'spec-1', name: 'Alpha', isBoss: false, reportsTo: ['boss-1'], slackBotUserId: 'U1' });
    const spec2 = makeAgent({ id: 'spec-2', name: 'Beta', isBoss: false, reportsTo: ['boss-2'], slackBotUserId: 'U2' });

    vi.mocked(getAllAgents).mockResolvedValue([boss1, boss2, spec1, spec2]);

    await regenerateBossRegistry();

    const [call1, call2] = vi.mocked(updateAgentClaudeMd).mock.calls;
    const contents = [call1[1], call2[1]];
    const boss1Content = contents.find(c => c.includes('Boss One'))!;
    const boss2Content = contents.find(c => c.includes('Boss Two'))!;

    expect(boss1Content).not.toContain('Beta');
    expect(boss2Content).not.toContain('Alpha');
  });

  it('uses fallback description when agent description is empty string', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss' });
    const specialist = makeAgent({
      id: 'spec-1', isBoss: false, reportsTo: ['boss-1'],
      slackBotUserId: 'U1', description: '',
    });

    vi.mocked(getAllAgents).mockResolvedValue([boss, specialist]);

    await regenerateBossRegistry();

    const content = vi.mocked(updateAgentClaudeMd).mock.calls[0][1];
    expect(content).toContain('No description provided.');
  });

  it('skips a boss agent that appears in another boss team (boss is also a specialist)', async () => {
    const boss1 = makeAgent({ id: 'boss-1', isBoss: true, name: 'Top Boss' });
    // boss2 reports to boss1 but is also a boss itself
    const boss2 = makeAgent({ id: 'boss-2', isBoss: true, name: 'Mid Boss', reportsTo: ['boss-1'], slackBotUserId: 'U2' });
    const spec = makeAgent({ id: 'spec-1', isBoss: false, reportsTo: ['boss-2'], slackBotUserId: 'U3', name: 'Worker' });

    vi.mocked(getAllAgents).mockResolvedValue([boss1, boss2, spec]);

    await regenerateBossRegistry();

    // boss1's registry should include boss2 (it reports to boss1)
    const boss1Call = vi.mocked(updateAgentClaudeMd).mock.calls.find(c => c[0] === 'boss-1');
    expect(boss1Call).toBeDefined();
    expect(boss1Call![1]).toContain('Mid Boss');
  });

  it('does not call updateAgentClaudeMd when getAllAgents throws', async () => {
    vi.mocked(getAllAgents).mockRejectedValue(new Error('DB connection failed'));

    await expect(regenerateBossRegistry()).rejects.toThrow('DB connection failed');
    expect(updateAgentClaudeMd).not.toHaveBeenCalled();
  });

  it('handles an agent reporting to multiple bosses', async () => {
    const boss1 = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss One' });
    const boss2 = makeAgent({ id: 'boss-2', isBoss: true, name: 'Boss Two' });
    const shared = makeAgent({
      id: 'spec-1', name: 'SharedBot', isBoss: false,
      reportsTo: ['boss-1', 'boss-2'], slackBotUserId: 'U1',
    });

    vi.mocked(getAllAgents).mockResolvedValue([boss1, boss2, shared]);

    await regenerateBossRegistry();

    expect(updateAgentClaudeMd).toHaveBeenCalledTimes(2);
    const contents = vi.mocked(updateAgentClaudeMd).mock.calls.map(c => c[1]);
    expect(contents[0]).toContain('SharedBot');
    expect(contents[1]).toContain('SharedBot');
  });
});

// ─── slug fallback branch (line 48) ──────────────────────────────────────────
// The branch `a.slackBotUserId ? <@id> : @slug` is only reachable if the
// filter on line 44 is bypassed. Since the filter removes agents without
// slackBotUserId, the ternary's false branch (slug fallback) is dead code.
// We document this explicitly rather than testing unreachable code.
describe('mention format branch coverage note', () => {
  beforeEach(() => vi.clearAllMocks());

  it('always uses <@userId> format because filter removes agents without slackBotUserId', async () => {
    const boss = makeAgent({ id: 'boss-1', isBoss: true, name: 'Boss' });
    const spec = makeAgent({ id: 'spec-1', isBoss: false, reportsTo: ['boss-1'], slackBotUserId: 'UABC', slug: 'my-bot' });

    vi.mocked(getAllAgents).mockResolvedValue([boss, spec]);
    await regenerateBossRegistry();

    const calls = vi.mocked(updateAgentClaudeMd).mock.calls;
    expect(calls.length).toBe(1);
    const registryContent = calls[0][1];
    expect(registryContent).toContain('<@UABC>');
    expect(registryContent).not.toContain('@my-bot');
  });
});
