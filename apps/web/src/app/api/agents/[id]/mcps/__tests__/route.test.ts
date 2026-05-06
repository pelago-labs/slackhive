import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  getAgentMcpServers: vi.fn(),
  setAgentMcps: vi.fn(),
  getMcpServerById: vi.fn(),
  getAgentById: vi.fn(),
  getAgentSkills: vi.fn(),
  getAgentPermissions: vi.fn(),
  publishAgentEvent: vi.fn(),
  createSnapshot: vi.fn(),
}));

vi.mock('@/lib/api-guard', () => ({
  guardAuth: vi.fn(),
  guardAgentWrite: vi.fn(),
}));

vi.mock('@/lib/compile', () => ({
  skillToSnapshotSkill: vi.fn((s: unknown) => s),
}));

import {
  getAgentMcpServers, setAgentMcps, getMcpServerById,
  getAgentById, getAgentSkills, getAgentPermissions,
  publishAgentEvent, createSnapshot,
} from '@/lib/db';
import { guardAuth, guardAgentWrite } from '@/lib/api-guard';

const COOKIE = 'auth_session';

function makeMcp(id: string, createdBy: string) {
  return { id, name: `mcp-${id}`, createdBy, type: 'stdio', config: {}, createdAt: new Date(), updatedAt: new Date() };
}

function makeAgent() {
  return {
    id: 'agent-1', name: 'Test', slug: 'test', claudeMd: '',
    description: '', slackBotToken: '', slackAppToken: '',
    slackSigningSecret: '', model: 'claude-opus-4-6', status: 'running',
    enabled: true, isBoss: false, reportsTo: [], createdBy: 'system',
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeReq(method: string, body?: unknown, session?: SessionPayload): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['cookie'] = `${COOKIE}=${signSession(session)}`;
  return new Request('http://localhost/api/agents/agent-1/mcps', {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: 'agent-1' });

async function loadRoute() {
  return await import('@/app/api/agents/[id]/mcps/route');
}

beforeEach(() => {
  vi.mocked(getAgentMcpServers).mockReset();
  vi.mocked(setAgentMcps).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(getMcpServerById).mockReset();
  vi.mocked(getAgentById).mockReset().mockResolvedValue(makeAgent() as any);
  vi.mocked(getAgentSkills).mockReset().mockResolvedValue([]);
  vi.mocked(getAgentPermissions).mockReset().mockResolvedValue({ allowedTools: [], deniedTools: [] } as any);
  vi.mocked(publishAgentEvent).mockReset().mockResolvedValue(undefined);
  vi.mocked(createSnapshot).mockReset().mockResolvedValue({} as any);
  vi.mocked(guardAuth).mockReset().mockReturnValue(null as any);
  vi.mocked(guardAgentWrite).mockReset().mockResolvedValue(null as any);
});

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/agents/[id]/mcps', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(guardAuth).mockReturnValue(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 }) as any);
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET'), { params });
    expect(res.status).toBe(401);
  });

  it('returns 200 with MCP list for viewer', async () => {
    vi.mocked(getAgentMcpServers).mockResolvedValue([makeMcp('m1', 'alice')] as any);
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET', undefined, { username: 'bob', role: 'viewer' }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it('returns 200 for editor', async () => {
    vi.mocked(getAgentMcpServers).mockResolvedValue([]);
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET', undefined, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(200);
  });
});

// ─── PUT ─────────────────────────────────────────────────────────────────────

describe('PUT /api/agents/[id]/mcps', () => {
  it('returns 401 when not authenticated', async () => {
    const { PUT } = await loadRoute();
    const res = await PUT(makeReq('PUT', { mcpIds: [] }), { params });
    expect(res.status).toBe(401);
  });

  it('returns 403 when agent write is denied (viewer/non-owner)', async () => {
    vi.mocked(guardAgentWrite).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) as any
    );
    const { PUT } = await loadRoute();
    const res = await PUT(makeReq('PUT', { mcpIds: [] }, { username: 'bob', role: 'viewer' }), { params });
    expect(res.status).toBe(403);
  });

  it('returns 403 when editor tries to add MCP owned by another user', async () => {
    vi.mocked(getAgentMcpServers).mockResolvedValue([]);
    vi.mocked(getMcpServerById).mockResolvedValue(makeMcp('m1', 'alice') as any);
    const { PUT } = await loadRoute();
    const res = await PUT(makeReq('PUT', { mcpIds: ['m1'] }, { username: 'bob', role: 'editor' }), { params });
    expect(res.status).toBe(403);
  });

  it('returns 403 when editor tries to remove MCP owned by another user', async () => {
    vi.mocked(getAgentMcpServers).mockResolvedValue([makeMcp('m1', 'alice')] as any);
    vi.mocked(getMcpServerById).mockResolvedValue(makeMcp('m1', 'alice') as any);
    const { PUT } = await loadRoute();
    const res = await PUT(makeReq('PUT', { mcpIds: [] }, { username: 'bob', role: 'editor' }), { params });
    expect(res.status).toBe(403);
  });

  it('returns 200 when editor adds their own MCP even when agent has other-owned MCPs', async () => {
    const otherMcp = makeMcp('m-other', 'alice');
    const myMcp = makeMcp('m-mine', 'bob');
    vi.mocked(getAgentMcpServers).mockResolvedValue([otherMcp] as any);
    vi.mocked(getMcpServerById).mockResolvedValue(myMcp as any);
    const { PUT } = await loadRoute();
    const res = await PUT(
      makeReq('PUT', { mcpIds: ['m-other', 'm-mine'] }, { username: 'bob', role: 'editor' }),
      { params }
    );
    expect(res.status).toBe(200);
  });

  it('returns 200 when editor removes their own MCP', async () => {
    const myMcp = makeMcp('m-mine', 'bob');
    vi.mocked(getAgentMcpServers).mockResolvedValue([myMcp] as any);
    vi.mocked(getMcpServerById).mockResolvedValue(myMcp as any);
    const { PUT } = await loadRoute();
    const res = await PUT(makeReq('PUT', { mcpIds: [] }, { username: 'bob', role: 'editor' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 200 when admin changes any MCP', async () => {
    vi.mocked(getAgentMcpServers).mockResolvedValue([]);
    const { PUT } = await loadRoute();
    const res = await PUT(makeReq('PUT', { mcpIds: ['m1'] }, { username: 'admin', role: 'admin' }), { params });
    expect(res.status).toBe(200);
  });

  it('does not create snapshot when MCP list is unchanged', async () => {
    vi.mocked(getAgentMcpServers).mockResolvedValue([makeMcp('m1', 'admin')] as any);
    const { PUT } = await loadRoute();
    await PUT(makeReq('PUT', { mcpIds: ['m1'] }, { username: 'admin', role: 'admin' }), { params });
    expect(vi.mocked(createSnapshot)).not.toHaveBeenCalled();
  });

  it('creates snapshot when MCP list changes', async () => {
    vi.mocked(getAgentMcpServers).mockResolvedValue([makeMcp('m1', 'admin')] as any);
    const { PUT } = await loadRoute();
    await PUT(makeReq('PUT', { mcpIds: ['m2'] }, { username: 'admin', role: 'admin' }), { params });
    expect(vi.mocked(createSnapshot)).toHaveBeenCalledOnce();
  });
});
