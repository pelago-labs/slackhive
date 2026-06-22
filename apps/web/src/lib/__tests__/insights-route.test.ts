/**
 * @fileoverview Tests for the LLMOps insights API route — auth gate (editors+ allowed,
 * viewers blocked) and the superadmin-only billing strip (tokens/cost/power-users
 * never reach a non-superadmin's response).
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
    listTasks: vi.fn().mockResolvedValue({ tasks: [], nextCursor: null }),
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

describe('GET /api/activity/insights — auth + billing gate', () => {
  it('401 without a session', async () => {
    const { GET } = await loadRoute();
    expect((await GET(requestAs(null) as any)).status).toBe(401);
  });

  it('403 for viewer', async () => {
    const { GET } = await loadRoute();
    expect((await GET(requestAs('viewer') as any)).status).toBe(403);
  });

  it('editor gets 200 but NO billing data (tokens/cost zeroed, powerUsers null)', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('editor') as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.billing).toBe(false);
    expect(body.powerUsers).toBeNull();
    expect(body.rollup.totalTokens).toBe(0);
    expect(body.rollup.costUsd).toBe(0);
    expect(body.rollup.tokensByDay).toEqual([]);
    expect(body.byAgent[0].inputTokens).toBe(0);
    expect(getTopUsers).not.toHaveBeenCalled(); // power users not even queried
  });

  it('superadmin gets full billing data', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('superadmin') as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.billing).toBe(true);
    expect(body.rollup.totalTokens).toBe(700);
    expect(body.rollup.costUsd).toBe(1.23);
    expect(body.powerUsers).toHaveLength(1);
    expect(getTopUsers).toHaveBeenCalledTimes(1);
  });
});
