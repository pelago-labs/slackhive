import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  getAgentById: vi.fn(),
  fetchSlackBotProfile: vi.fn(),
}));

vi.mock('@slackhive/shared', async () => {
  const actual = await vi.importActual<typeof import('@slackhive/shared')>('@slackhive/shared');
  return { ...actual, getDb: vi.fn() };
});

import { getAgentById, fetchSlackBotProfile } from '@/lib/db';
import { getDb } from '@slackhive/shared';

const COOKIE = 'auth_session';

function makeAgent(overrides: Partial<{ slackBotToken: string; slackBotHandle: string; slackBotImageUrl: string }> = {}) {
  return {
    id: 'agent-1', slug: 'test', name: 'Test', model: 'claude-opus-4-6',
    status: 'running', enabled: true, isBoss: false, verbose: true,
    reportsTo: [], claudeMd: '', createdBy: 'admin',
    createdAt: new Date(), updatedAt: new Date(), tags: [],
    slackBotToken: 'xoxb-test',
    ...overrides,
  };
}

function makeReq(session?: SessionPayload): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['cookie'] = `${COOKIE}=${signSession(session)}`;
  return new Request('http://localhost/api/agents/agent-1/refresh-slack-profile', {
    method: 'POST', headers,
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: 'agent-1' });

async function loadRoute() {
  return await import('@/app/api/agents/[id]/refresh-slack-profile/route');
}

const queryMock = vi.fn();
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  vi.mocked(getDb).mockReturnValue({ query: queryMock } as unknown as ReturnType<typeof getDb>);
  vi.mocked(getAgentById).mockReset();
  vi.mocked(fetchSlackBotProfile).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/agents/[id]/refresh-slack-profile', () => {
  it('returns 401 when not authenticated', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(401);
    expect(getAgentById).not.toHaveBeenCalled();
  });

  it('returns 404 when agent not found', async () => {
    vi.mocked(getAgentById).mockResolvedValue(null);
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns ok:false with reason when agent has no Slack token', async () => {
    vi.mocked(getAgentById).mockResolvedValue(makeAgent({ slackBotToken: undefined }) as any);
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: 'no-slack-token' });
    expect(fetchSlackBotProfile).not.toHaveBeenCalled();
  });

  it('returns ok:false when Slack API returns nothing', async () => {
    vi.mocked(getAgentById).mockResolvedValue(makeAgent() as any);
    vi.mocked(fetchSlackBotProfile).mockResolvedValue({ handle: null, userId: null, imageUrl: null });
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ username: 'alice', role: 'editor' }), { params });
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: 'slack-api-failed' });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('persists handle + image when Slack returns them; returns updated values', async () => {
    vi.mocked(getAgentById).mockResolvedValue(makeAgent() as any);
    vi.mocked(fetchSlackBotProfile).mockResolvedValue({
      handle: 'test-bot',
      userId: 'U123',
      imageUrl: 'https://avatars.slack-edge.com/test_192.png',
    });
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.slackBotHandle).toBe('test-bot');
    expect(body.slackBotImageUrl).toBe('https://avatars.slack-edge.com/test_192.png');
    // Verify DB UPDATE was called with the right params
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE platform_integrations'),
      ['test-bot', 'https://avatars.slack-edge.com/test_192.png', 'agent-1'],
    );
  });

  it('persists partial result (handle only) when image is missing', async () => {
    vi.mocked(getAgentById).mockResolvedValue(makeAgent() as any);
    vi.mocked(fetchSlackBotProfile).mockResolvedValue({
      handle: 'test-bot', userId: 'U123', imageUrl: null,
    });
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.slackBotHandle).toBe('test-bot');
    expect(queryMock).toHaveBeenCalledWith(
      expect.any(String),
      ['test-bot', null, 'agent-1'],
    );
  });

  it('any logged-in role can call this endpoint (viewer included)', async () => {
    vi.mocked(getAgentById).mockResolvedValue(makeAgent() as any);
    vi.mocked(fetchSlackBotProfile).mockResolvedValue({ handle: 'b', userId: 'U', imageUrl: 'https://x.png' });
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ username: 'viewer', role: 'viewer' }), { params });
    expect(res.status).toBe(200);
  });
});
