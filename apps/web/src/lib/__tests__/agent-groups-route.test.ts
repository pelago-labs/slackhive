/**
 * @fileoverview Route-level tests for the agent-audiences endpoints.
 *
 * Covers the validation and authorization paths added by the audiences
 * feature — these can't be exercised through the lib helpers alone:
 *  - PATCH rejects empty name (matches POST behavior)
 *  - PATCH/DELETE/members PUT all 404 when the URL agent doesn't own the
 *    referenced group (cross-agent guard)
 *  - POST/PATCH normalise empty-string description to null
 *  - Range/integer validation on priority
 *
 * @module web/lib/__tests__/agent-groups-route
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';

vi.mock('@/lib/db', () => ({
  listAgentGroups:        vi.fn(),
  createAgentGroup:       vi.fn(),
  getAgentGroup:          vi.fn(),
  updateAgentGroup:       vi.fn(),
  deleteAgentGroup:       vi.fn(),
  listGroupMembers:       vi.fn(),
  setGroupMembers:        vi.fn(),
  parseAgentGroupsConflict: vi.fn(() => null),
}));

import {
  createAgentGroup,
  getAgentGroup,
  updateAgentGroup,
  deleteAgentGroup,
  setGroupMembers,
  listGroupMembers,
} from '@/lib/db';

const COOKIE_NAME = 'auth_session';
const adminSession: SessionPayload = { username: 'admin', role: 'admin' };
const viewerSession: SessionPayload = { username: 'aman', role: 'viewer' };
function authHeaders(s: SessionPayload = adminSession) {
  return { cookie: `${COOKIE_NAME}=${signSession(s)}` };
}

function jsonReq(method: string, body: unknown, session: SessionPayload = adminSession): Request {
  return new Request('http://localhost', {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders(session) },
    body: JSON.stringify(body),
  }) as Request;
}

beforeEach(() => {
  vi.mocked(createAgentGroup).mockReset();
  vi.mocked(getAgentGroup).mockReset();
  vi.mocked(updateAgentGroup).mockReset();
  vi.mocked(deleteAgentGroup).mockReset().mockResolvedValue(undefined);
  vi.mocked(setGroupMembers).mockReset().mockResolvedValue(undefined);
  vi.mocked(listGroupMembers).mockReset().mockResolvedValue([]);
});

// ─── POST /api/agents/[id]/groups ─────────────────────────────────────────

describe('POST /api/agents/[id]/groups', () => {
  it('rejects an empty name with 400', async () => {
    const { POST } = await import('@/app/api/agents/[id]/groups/route');
    const res = await POST(jsonReq('POST', { name: '   ' }) as any, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(res.status).toBe(400);
  });

  it('rejects a non-integer priority with field=priority', async () => {
    const { POST } = await import('@/app/api/agents/[id]/groups/route');
    const res = await POST(jsonReq('POST', { name: 'Marketing', priority: 1.5 }) as any, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('priority');
  });

  it('normalises empty/whitespace description to null', async () => {
    vi.mocked(createAgentGroup).mockResolvedValue({ id: 'g1', agentId: 'agent-1', name: 'Marketing' } as any);
    const { POST } = await import('@/app/api/agents/[id]/groups/route');
    await POST(jsonReq('POST', { name: 'Marketing', description: '   ' }) as any, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(createAgentGroup).toHaveBeenCalledWith(expect.objectContaining({ description: null }));
  });

  it('passes a non-empty description through', async () => {
    vi.mocked(createAgentGroup).mockResolvedValue({ id: 'g1' } as any);
    const { POST } = await import('@/app/api/agents/[id]/groups/route');
    await POST(jsonReq('POST', { name: 'Marketing', description: 'brand team' }) as any, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(createAgentGroup).toHaveBeenCalledWith(expect.objectContaining({ description: 'brand team' }));
  });
});

// ─── PATCH /api/agents/[id]/groups/[groupId] ──────────────────────────────

describe('PATCH /api/agents/[id]/groups/[groupId]', () => {
  function ownedGroup(agentId = 'agent-1', groupId = 'group-1') {
    return { id: groupId, agentId, name: 'old', description: null, instructions: '', priority: 100, verbose: false };
  }

  it('returns 404 when the URL agent does not own the group (cross-agent guard)', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue(ownedGroup('agent-OTHER') as any);
    const { PATCH } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const res = await PATCH(
      jsonReq('PATCH', { name: 'hacked' }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'group-1' }) },
    );
    expect(res.status).toBe(404);
    expect(updateAgentGroup).not.toHaveBeenCalled();
  });

  it('returns 404 when the group does not exist', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue(null);
    const { PATCH } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const res = await PATCH(
      jsonReq('PATCH', { name: 'rename' }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'group-1' }) },
    );
    expect(res.status).toBe(404);
  });

  it('rejects an empty name with field=name', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue(ownedGroup() as any);
    const { PATCH } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const res = await PATCH(
      jsonReq('PATCH', { name: '   ' }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'group-1' }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('name');
    expect(updateAgentGroup).not.toHaveBeenCalled();
  });

  it('normalises empty description to null', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue(ownedGroup() as any);
    vi.mocked(updateAgentGroup).mockResolvedValue(ownedGroup() as any);
    const { PATCH } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    await PATCH(
      jsonReq('PATCH', { description: '   ' }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'group-1' }) },
    );
    expect(updateAgentGroup).toHaveBeenCalledWith('group-1', expect.objectContaining({ description: null }));
  });

  it('rejects a non-integer priority (1.5) with field=priority', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue(ownedGroup() as any);
    const { PATCH } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const res = await PATCH(
      jsonReq('PATCH', { priority: 1.5 }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'group-1' }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('priority');
  });

  it('rejects a negative priority', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue(ownedGroup() as any);
    const { PATCH } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const res = await PATCH(
      jsonReq('PATCH', { priority: -5 }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'group-1' }) },
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue(ownedGroup() as any);
    const { PATCH } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const res = await PATCH(
      new Request('http://localhost', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'group-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for viewer role', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue(ownedGroup() as any);
    const { PATCH } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const res = await PATCH(
      jsonReq('PATCH', { name: 'x' }, viewerSession) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'group-1' }) },
    );
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/agents/[id]/groups/[groupId] ────────────────────────────────

describe('GET /api/agents/[id]/groups/[groupId]', () => {
  it('returns 404 when the URL agent does not own the group (cross-agent read guard)', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue({ id: 'g1', agentId: 'agent-OTHER', name: 'leaked' } as any);
    const { GET } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const req = new Request('http://localhost', { headers: authHeaders() }) as any;
    const res = await GET(req, { params: Promise.resolve({ id: 'agent-1', groupId: 'g1' }) });
    expect(res.status).toBe(404);
    // Critical: must NOT leak the group payload in the body.
    const body = await res.json();
    expect(body.group).toBeUndefined();
    expect(body.name).toBeUndefined();
  });

  it('returns 401 for unauthenticated', async () => {
    const { GET } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const req = new Request('http://localhost') as any;
    const res = await GET(req, { params: Promise.resolve({ id: 'agent-1', groupId: 'g1' }) });
    expect(res.status).toBe(401);
  });

  it('returns the group when the URL agent owns it', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue({ id: 'g1', agentId: 'agent-1', name: 'Marketing' } as any);
    vi.mocked(listGroupMembers).mockResolvedValue([{ userId: 'u1', username: 'aman' }]);
    const { GET } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const req = new Request('http://localhost', { headers: authHeaders() }) as any;
    const res = await GET(req, { params: Promise.resolve({ id: 'agent-1', groupId: 'g1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group.name).toBe('Marketing');
    expect(body.members).toHaveLength(1);
  });
});

// ─── DELETE /api/agents/[id]/groups/[groupId] ─────────────────────────────

describe('DELETE /api/agents/[id]/groups/[groupId]', () => {
  it('refuses to delete a group owned by a different agent', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue({ id: 'g1', agentId: 'agent-OTHER' } as any);
    const { DELETE } = await import('@/app/api/agents/[id]/groups/[groupId]/route');
    const res = await DELETE(
      jsonReq('DELETE', {}) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'g1' }) },
    );
    expect(res.status).toBe(404);
    expect(deleteAgentGroup).not.toHaveBeenCalled();
  });
});

// ─── PUT /api/agents/[id]/groups/[groupId]/members ────────────────────────

describe('PUT /api/agents/[id]/groups/[groupId]/members', () => {
  it('refuses to mutate members of a group owned by a different agent', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue({ id: 'g1', agentId: 'agent-OTHER' } as any);
    const { PUT } = await import('@/app/api/agents/[id]/groups/[groupId]/members/route');
    const res = await PUT(
      jsonReq('PUT', { userIds: ['u1', 'u2'] }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'g1' }) },
    );
    expect(res.status).toBe(404);
    expect(setGroupMembers).not.toHaveBeenCalled();
  });

  it('400s when userIds is not an array', async () => {
    vi.mocked(getAgentGroup).mockResolvedValue({ id: 'g1', agentId: 'agent-1' } as any);
    const { PUT } = await import('@/app/api/agents/[id]/groups/[groupId]/members/route');
    const res = await PUT(
      jsonReq('PUT', { userIds: 'nope' }) as any,
      { params: Promise.resolve({ id: 'agent-1', groupId: 'g1' }) },
    );
    expect(res.status).toBe(400);
  });
});
