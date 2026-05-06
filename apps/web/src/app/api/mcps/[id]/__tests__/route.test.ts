import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  getMcpServerById: vi.fn(),
  updateMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
}));

vi.mock('@/lib/mcp-mask', () => ({
  maskMcpServer: vi.fn((s: unknown) => s),
  mergeMcpConfig: vi.fn((_: unknown, b: unknown) => b),
}));

import { getMcpServerById, updateMcpServer, deleteMcpServer } from '@/lib/db';

const COOKIE = 'auth_session';

function makeServer(overrides: Partial<{ id: string; createdBy: string }> = {}) {
  return {
    id: 'mcp-1',
    name: 'Test MCP',
    type: 'stdio',
    config: { command: 'npx', args: ['test'] },
    createdBy: 'alice',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeReq(method: string, body?: unknown, session?: SessionPayload): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['cookie'] = `${COOKIE}=${signSession(session)}`;
  return new Request('http://localhost/api/mcps/mcp-1', {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: 'mcp-1' });

async function loadRoute() {
  return await import('@/app/api/mcps/[id]/route');
}

beforeEach(() => {
  vi.mocked(getMcpServerById).mockReset();
  vi.mocked(updateMcpServer).mockReset();
  vi.mocked(deleteMcpServer).mockReset();
});

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/mcps/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET'), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when MCP not found', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET', undefined, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 200 for viewer', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer() as any);
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET', undefined, { username: 'bob', role: 'viewer' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 200 for editor (any MCP)', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer({ createdBy: 'someone-else' }) as any);
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET', undefined, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 200 for admin', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer() as any);
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET', undefined, { username: 'bob', role: 'admin' }), { params });
    expect(res.status).toBe(200);
  });
});

// ─── PATCH ───────────────────────────────────────────────────────────────────

describe('PATCH /api/mcps/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { name: 'New' }), { params });
    expect(res.status).toBe(401);
  });

  it('returns 403 for viewer', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { name: 'New' }, { username: 'bob', role: 'viewer' }), { params });
    expect(res.status).toBe(403);
  });

  it('returns 403 for editor trying to edit another user MCP', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer({ createdBy: 'alice' }) as any);
    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { name: 'New' }, { username: 'bob', role: 'editor' }), { params });
    expect(res.status).toBe(403);
  });

  it('returns 200 for editor editing own MCP', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer({ createdBy: 'alice' }) as any);
    vi.mocked(updateMcpServer).mockResolvedValue(makeServer() as any);
    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { name: 'New' }, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 200 for admin editing any MCP', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer({ createdBy: 'alice' }) as any);
    vi.mocked(updateMcpServer).mockResolvedValue(makeServer() as any);
    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { name: 'New' }, { username: 'bob', role: 'admin' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 200 for superadmin editing any MCP', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer({ createdBy: 'alice' }) as any);
    vi.mocked(updateMcpServer).mockResolvedValue(makeServer() as any);
    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { name: 'New' }, { username: 'super', role: 'superadmin' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 404 when MCP not found', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(null);
    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { name: 'New' }, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

describe('DELETE /api/mcps/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    const { DELETE } = await loadRoute();
    const res = await DELETE(makeReq('DELETE'), { params });
    expect(res.status).toBe(401);
  });

  it('returns 403 for viewer', async () => {
    const { DELETE } = await loadRoute();
    const res = await DELETE(makeReq('DELETE', undefined, { username: 'bob', role: 'viewer' }), { params });
    expect(res.status).toBe(403);
  });

  it('returns 403 for editor deleting another user MCP', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer({ createdBy: 'alice' }) as any);
    const { DELETE } = await loadRoute();
    const res = await DELETE(makeReq('DELETE', undefined, { username: 'bob', role: 'editor' }), { params });
    expect(res.status).toBe(403);
  });

  it('returns 204 for editor deleting own MCP', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer({ createdBy: 'alice' }) as any);
    vi.mocked(deleteMcpServer).mockResolvedValue(undefined as any);
    const { DELETE } = await loadRoute();
    const res = await DELETE(makeReq('DELETE', undefined, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(204);
  });

  it('returns 204 for admin deleting any MCP', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(makeServer({ createdBy: 'alice' }) as any);
    vi.mocked(deleteMcpServer).mockResolvedValue(undefined as any);
    const { DELETE } = await loadRoute();
    const res = await DELETE(makeReq('DELETE', undefined, { username: 'bob', role: 'admin' }), { params });
    expect(res.status).toBe(204);
  });

  it('returns 404 when MCP not found', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(null);
    const { DELETE } = await loadRoute();
    const res = await DELETE(makeReq('DELETE', undefined, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(404);
  });
});
