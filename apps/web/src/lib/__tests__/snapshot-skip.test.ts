/**
 * @fileoverview Unit tests for snapshot change detection in API routes.
 *
 * Verifies that createSnapshot is NOT called when saving identical values,
 * and IS called when values actually change. Tests cover:
 * - claude-md: identical content → no snapshot
 * - claude-md: changed content → snapshot created
 * - permissions: identical tools → no snapshot
 * - permissions: changed tools → snapshot created
 * - mcps: identical IDs → no snapshot
 * - mcps: changed IDs → snapshot created
 * - restrictions: identical channels → no snapshot
 * - restrictions: changed channels → snapshot created
 * - skills: identical content → no snapshot
 * - skills: new skill → snapshot created
 *
 * @module web/lib/__tests__/snapshot-skip.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  getAgentById: vi.fn(),
  getAgentSkills: vi.fn(),
  getAgentPermissions: vi.fn(),
  getAgentMcpServers: vi.fn(),
  getAgentRestrictions: vi.fn(),
  createSnapshot: vi.fn(),
  updateAgentClaudeMd: vi.fn(),
  upsertPermissions: vi.fn(),
  upsertRestrictions: vi.fn(),
  setAgentMcps: vi.fn(),
  upsertSkill: vi.fn(),
  publishAgentEvent: vi.fn(),
}));

vi.mock('@/lib/api-guard', () => ({
  guardAgentWrite: vi.fn(),
}));

import { guardAgentWrite } from '@/lib/api-guard';

vi.mock('@/lib/compile', () => ({
  skillToSnapshotSkill: (s: any) => ({ filename: s.filename, content: s.content }),
}));

import {
  getAgentById, getAgentSkills, getAgentPermissions, getAgentMcpServers,
  getAgentRestrictions, createSnapshot, updateAgentClaudeMd, upsertPermissions,
  upsertRestrictions, setAgentMcps, upsertSkill, publishAgentEvent,
} from '@/lib/db';

// ─── Helpers ────────────────────────────────────────────────────────────────

const COOKIE_NAME = 'auth_session';
const session: SessionPayload = { username: 'admin', role: 'admin' };

function makeAgent(claudeMd = '') {
  return {
    id: 'agent-1', name: 'Test', slug: 'test', claudeMd,
    description: '', platform: 'slack', platformCredentials: { botToken: 'xoxb-test', appToken: 'xapp-test', signingSecret: 's' },
    hasPlatformCreds: true, model: 'claude-opus-4-6', status: 'running',
    enabled: true, isBoss: false, reportsTo: [], createdBy: 'system',
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function authHeaders(): Record<string, string> {
  return { cookie: `${COOKIE_NAME}=${signSession(session)}` };
}

beforeEach(() => {
  vi.mocked(createSnapshot).mockClear().mockResolvedValue({} as any);
  vi.mocked(getAgentById).mockReset().mockResolvedValue(makeAgent('original content') as any);
  vi.mocked(getAgentSkills).mockReset().mockResolvedValue([]);
  vi.mocked(getAgentPermissions).mockReset().mockResolvedValue({ allowedTools: ['Read'], deniedTools: [] } as any);
  vi.mocked(getAgentMcpServers).mockReset().mockResolvedValue([{ id: 'mcp-1', name: 'test-mcp' }] as any);
  vi.mocked(getAgentRestrictions).mockReset().mockResolvedValue({ allowedChannels: ['C123'] } as any);
  vi.mocked(publishAgentEvent).mockReset().mockResolvedValue(undefined);
  vi.mocked(updateAgentClaudeMd).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(upsertPermissions).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(upsertRestrictions).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(setAgentMcps).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(upsertSkill).mockReset().mockResolvedValue({ id: 's1', category: 'commands', filename: 'test.md', content: 'new' } as any);
  vi.mocked(guardAgentWrite).mockReset().mockResolvedValue(null as any);
});

// ─── claude-md ──────────────────────────────────────────────────────────────

describe('claude-md snapshot skip', () => {
  let PUT: Function;
  beforeEach(async () => {
    ({ PUT } = await import('@/app/api/agents/[id]/claude-md/route'));
  });

  it('skips snapshot when content is unchanged', async () => {
    const req = new Request('http://localhost/api/agents/agent-1/claude-md', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'text/plain' },
      body: 'original content',
    });
    await PUT(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).not.toHaveBeenCalled();
  });

  it('creates snapshot when content changes', async () => {
    const req = new Request('http://localhost/api/agents/agent-1/claude-md', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'text/plain' },
      body: 'new content',
    });
    await PUT(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).toHaveBeenCalledTimes(1);
  });
});

// ─── permissions ────────────────────────────────────────────────────────────

describe('permissions snapshot skip', () => {
  let PUT: Function;
  beforeEach(async () => {
    ({ PUT } = await import('@/app/api/agents/[id]/permissions/route'));
  });

  it('skips snapshot when permissions are unchanged', async () => {
    const req = new Request('http://localhost/api/agents/agent-1/permissions', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ allowedTools: ['Read'], deniedTools: [] }),
    });
    await PUT(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).not.toHaveBeenCalled();
  });

  it('creates snapshot when permissions change', async () => {
    const req = new Request('http://localhost/api/agents/agent-1/permissions', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ allowedTools: ['Read', 'Write'], deniedTools: [] }),
    });
    await PUT(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).toHaveBeenCalledTimes(1);
  });
});

// ─── mcps ───────────────────────────────────────────────────────────────────

describe('mcps snapshot skip', () => {
  let PUT: Function;
  beforeEach(async () => {
    ({ PUT } = await import('@/app/api/agents/[id]/mcps/route'));
  });

  it('skips snapshot when MCP IDs are unchanged', async () => {
    const req = new Request('http://localhost/api/agents/agent-1/mcps', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['mcp-1'] }),
    });
    await PUT(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).not.toHaveBeenCalled();
  });

  it('creates snapshot when MCP IDs change', async () => {
    const req = new Request('http://localhost/api/agents/agent-1/mcps', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['mcp-1', 'mcp-2'] }),
    });
    await PUT(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).toHaveBeenCalledTimes(1);
  });
});

// ─── restrictions ───────────────────────────────────────────────────────────

describe('restrictions snapshot skip', () => {
  let PUT: Function;
  beforeEach(async () => {
    ({ PUT } = await import('@/app/api/agents/[id]/restrictions/route'));
  });

  it('skips snapshot when channels are unchanged', async () => {
    const req = new Request('http://localhost/api/agents/agent-1/restrictions', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ allowedChannels: ['C123'] }),
    });
    await PUT(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).not.toHaveBeenCalled();
  });

  it('creates snapshot when channels change', async () => {
    const req = new Request('http://localhost/api/agents/agent-1/restrictions', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ allowedChannels: ['C123', 'C456'] }),
    });
    await PUT(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).toHaveBeenCalledTimes(1);
  });
});

// ─── skills ─────────────────────────────────────────────────────────────────

describe('skills snapshot skip', () => {
  let POST: Function;
  beforeEach(async () => {
    ({ POST } = await import('@/app/api/agents/[id]/skills/route'));
  });

  it('skips snapshot when skill content is unchanged', async () => {
    vi.mocked(getAgentSkills).mockResolvedValue([
      { id: 's1', category: 'commands', filename: 'test.md', content: 'existing content', sortOrder: 0 },
    ] as any);
    const req = new NextRequest('http://localhost/api/agents/agent-1/skills', {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'commands', filename: 'test.md', content: 'existing content' }),
    });
    await POST(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).not.toHaveBeenCalled();
  });

  it('creates snapshot when skill content changes', async () => {
    vi.mocked(getAgentSkills).mockResolvedValue([
      { id: 's1', category: 'commands', filename: 'test.md', content: 'old content', sortOrder: 0 },
    ] as any);
    const req = new NextRequest('http://localhost/api/agents/agent-1/skills', {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'commands', filename: 'test.md', content: 'new content' }),
    });
    await POST(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).toHaveBeenCalledTimes(1);
  });

  it('creates snapshot for a new skill', async () => {
    const req = new NextRequest('http://localhost/api/agents/agent-1/skills', {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'commands', filename: 'new.md', content: 'brand new' }),
    });
    await POST(req, { params: Promise.resolve({ id: 'agent-1' }) });
    expect(vi.mocked(createSnapshot)).toHaveBeenCalledTimes(1);
  });
});
