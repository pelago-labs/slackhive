/**
 * @fileoverview Tests for the Activity Usage API route — focused on the
 * superadmin-only auth gate. PR #75 tightened this from "not viewer" to
 * "only superadmin" because the data is billing-adjacent; this test locks
 * that intent in so a future refactor can't quietly widen access.
 *
 * @module web/lib/__tests__/activity-usage-route
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { Role } from '@/lib/auth-context';

vi.mock('@slackhive/shared', async () => {
  const actual = await vi.importActual<typeof import('@slackhive/shared')>('@slackhive/shared');
  return {
    ...actual,
    getTokensByAgent: vi.fn(),
    getTopUsers: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({
  listAccessibleAgentIds: vi.fn(),
}));

import { getTokensByAgent, getTopUsers } from '@slackhive/shared';
import { listAccessibleAgentIds } from '@/lib/db';

const COOKIE_NAME = 'auth_session';

function requestAs(role: Role | null): Request {
  const url = 'http://localhost/api/activity/usage?window=24h';
  if (role === null) return new Request(url);
  const session: SessionPayload = { username: `user-${role}`, role };
  return new Request(url, { headers: { cookie: `${COOKIE_NAME}=${signSession(session)}` } });
}

async function loadRoute() {
  return await import('@/app/api/activity/usage/route');
}

beforeEach(() => {
  vi.mocked(getTokensByAgent).mockReset().mockResolvedValue([]);
  vi.mocked(getTopUsers).mockReset().mockResolvedValue([]);
  vi.mocked(listAccessibleAgentIds).mockReset().mockResolvedValue(null);
});

describe('GET /api/activity/usage — auth gate', () => {
  it('returns 401 when no session cookie is present', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs(null) as any);
    expect(res.status).toBe(401);
    expect(getTokensByAgent).not.toHaveBeenCalled();
  });

  it('returns 403 for viewer', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('viewer') as any);
    expect(res.status).toBe(403);
    expect(getTokensByAgent).not.toHaveBeenCalled();
  });

  it('returns 403 for editor', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('editor') as any);
    expect(res.status).toBe(403);
    expect(getTokensByAgent).not.toHaveBeenCalled();
  });

  it('returns 403 for admin', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('admin') as any);
    expect(res.status).toBe(403);
    expect(getTokensByAgent).not.toHaveBeenCalled();
  });

  it('returns 200 for superadmin', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('superadmin') as any);
    expect(res.status).toBe(200);
    expect(getTokensByAgent).toHaveBeenCalledTimes(1);
    expect(getTopUsers).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/activity/usage — filter passthrough', () => {
  // Regression guard: PR fixing power-users-respects-filters confirmed both
  // helpers receive the agent + window the UI sends. Without this assertion,
  // a future refactor could quietly drop the agent filter for one of them
  // and the leaderboard would silently show all-agents data.
  it('passes both agent and window to getTokensByAgent and getTopUsers', async () => {
    const session: SessionPayload = { username: 'super', role: 'superadmin' };
    const url = 'http://localhost/api/activity/usage?window=24h&agent=agent-xyz';
    const req = new Request(url, { headers: { cookie: `${COOKIE_NAME}=${signSession(session)}` } });
    const { GET } = await loadRoute();
    await GET(req as any);
    expect(getTokensByAgent).toHaveBeenCalledTimes(1);
    expect(getTopUsers).toHaveBeenCalledTimes(1);
    const tokensFilter = vi.mocked(getTokensByAgent).mock.calls[0][0];
    const usersFilter = vi.mocked(getTopUsers).mock.calls[0][0];
    expect(tokensFilter?.agentId).toBe('agent-xyz');
    expect(usersFilter?.agentId).toBe('agent-xyz');
    expect(typeof tokensFilter?.since).toBe('string');
    expect(tokensFilter?.since).toBe(usersFilter?.since);
  });
});

describe('GET /api/activity/usage — response shape', () => {
  it('returns byAgent, byUser, totals (with token fields zeroed when empty)', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('superadmin') as any);
    const body = await res.json();
    expect(body).toMatchObject({
      byAgent: [],
      byUser: [],
      totals: {
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        turnCount: 0,
      },
    });
  });

  it('sums byAgent rows into totals', async () => {
    vi.mocked(getTokensByAgent).mockResolvedValueOnce([
      { agentId: 'a1', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, turnCount: 2 },
      { agentId: 'a2', inputTokens: 50,  outputTokens: 5,  cacheReadTokens: 10, cacheCreationTokens: 0, turnCount: 1 },
    ]);
    const { GET } = await loadRoute();
    const res = await GET(requestAs('superadmin') as any);
    const body = await res.json();
    expect(body.totals).toEqual({
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      turnCount: 3,
    });
  });
});
