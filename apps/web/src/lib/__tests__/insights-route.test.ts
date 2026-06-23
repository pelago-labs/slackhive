/**
 * @fileoverview Tests for the LLMOps insights API route — auth gate (editors+ allowed,
 * viewers blocked) and the token-visibility policy: tokens/cost are visible to editor+
 * (editors are always scoped to their own agents), while the org-wide power-users
 * leaderboard stays superadmin-only.
 *
 * @module web/lib/__tests__/insights-route
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { Role } from '@/lib/auth-context';

vi.mock('@slackhive/shared', async () => {
  const actual = await vi.importActual<typeof import('@slackhive/shared')>('@slackhive/shared');
  const rollup = {
    sessions: 1, turns: 2, toolCalls: 1, generations: 1, errorTurns: 0,
    inputTokens: 500, outputTokens: 200, totalTokens: 700, costUsd: 1.23,
    p50DurationMs: 10, p95DurationMs: 20, feedbackUp: 1, feedbackDown: 0, sensitiveEvents: 0,
    tokensByDay: [{ date: '2026-01-01', input: 500, output: 200 }],
    topTools: [], models: [{ model: 'm', turns: 2, tokens: 700 }],
  };
  return {
    ...actual,
    getInsightsRollup: vi.fn().mockResolvedValue(rollup),
    getTokensByAgent: vi.fn().mockResolvedValue([{ agentId: 'ag', inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, turnCount: 2 }]),
    getTopUsers: vi.fn().mockResolvedValue([{ userId: 'u', handle: 'u', taskCount: 1, turnCount: 2, totalTokens: 700 }]),
    getSensitiveEvents: vi.fn().mockResolvedValue([]),
    getSensitiveFlows: vi.fn().mockResolvedValue([]),
    getToolStats: vi.fn().mockResolvedValue([]),
    getSessionSummaries: vi.fn().mockResolvedValue({
      sessions: [
        { sessionId: 's1', summary: 'hi', initiatorHandle: 'u', agentIds: ['ag'], turns: 2, inputTokens: 500, outputTokens: 200, status: 'done', sensitive: false, feedbackUp: 1, feedbackDown: 0, startedAt: '2026-01-01 00:00:00', lastActivityAt: '2026-01-01 00:01:00' },
      ],
      nextCursor: null,
    }),
  };
});

vi.mock('@/lib/db', () => ({ listAccessibleAgentIds: vi.fn() }));

import { getTopUsers } from '@slackhive/shared';
import { listAccessibleAgentIds } from '@/lib/db';

const COOKIE_NAME = 'auth_session';
function requestAs(role: Role | null): Request {
  const url = 'http://localhost/api/activity/insights?scope=all&window=24h';
  if (role === null) return new Request(url);
  const session: SessionPayload = { username: `user-${role}`, role };
  return new Request(url, { headers: { cookie: `${COOKIE_NAME}=${signSession(session)}` } });
}
async function loadRoute() { return await import('@/app/api/activity/insights/route'); }

beforeEach(() => {
  vi.mocked(listAccessibleAgentIds).mockReset().mockResolvedValue(null);
  vi.mocked(getTopUsers).mockClear();
});

describe('GET /api/activity/insights — auth + token-visibility policy', () => {
  it('401 without a session', async () => {
    const { GET } = await loadRoute();
    expect((await GET(requestAs(null) as any)).status).toBe(401);
  });

  it('403 for viewer', async () => {
    const { GET } = await loadRoute();
    expect((await GET(requestAs('viewer') as any)).status).toBe(403);
  });

  it('editor sees their agents\' tokens/cost but NOT the org-wide power-users leaderboard', async () => {
    // Editors are always scoped to their own agents, so their tokens/cost are their
    // own usage — returned in full. Only the org-wide power-users list is withheld.
    vi.mocked(listAccessibleAgentIds).mockResolvedValue(['ag']);
    const { GET } = await loadRoute();
    const res = await GET(requestAs('editor') as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    // tokens/cost present (scoped to the editor's agents)
    expect(body.rollup.totalTokens).toBe(700);
    expect(body.rollup.costUsd).toBe(1.23);
    expect(body.rollup.tokensByDay).toHaveLength(1);
    expect(body.byAgent[0].inputTokens).toBe(500);
    expect(body.sessions[0].inputTokens).toBe(500);
    // power-users leaderboard withheld and never even queried
    expect(body.powerUsers).toBeNull();
    expect(getTopUsers).not.toHaveBeenCalled();
  });

  it('admin sees tokens/cost but still NOT power-users (superadmin-only)', async () => {
    vi.mocked(listAccessibleAgentIds).mockResolvedValue(null); // admin = all agents
    const { GET } = await loadRoute();
    const res = await GET(requestAs('admin') as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rollup.totalTokens).toBe(700);
    expect(body.byAgent[0].inputTokens).toBe(500);
    expect(body.powerUsers).toBeNull();
    expect(getTopUsers).not.toHaveBeenCalled();
  });

  it('superadmin gets tokens/cost AND the power-users leaderboard', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('superadmin') as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rollup.totalTokens).toBe(700);
    expect(body.rollup.costUsd).toBe(1.23);
    expect(body.powerUsers).toHaveLength(1);
    expect(getTopUsers).toHaveBeenCalledTimes(1);
  });
});
