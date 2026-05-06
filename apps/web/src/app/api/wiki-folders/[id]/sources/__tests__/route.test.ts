import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  getWikiFolder: vi.fn(),
  getWikiSources: vi.fn(),
  createWikiSource: vi.fn(),
  getEnvVarCreatedBy: vi.fn(),
}));

import { getWikiFolder, createWikiSource, getEnvVarCreatedBy } from '@/lib/db';

const COOKIE = 'auth_session';

function makeFolder(overrides: Partial<{ id: string; createdBy: string }> = {}) {
  return { id: 'folder-1', name: 'Folder', createdBy: 'alice', createdAt: new Date(), updatedAt: new Date(), ...overrides };
}

function makeReq(method: string, body?: unknown, session?: SessionPayload): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['cookie'] = `${COOKIE}=${signSession(session)}`;
  return new Request('http://localhost/api/wiki-folders/folder-1/sources', {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: 'folder-1' });

async function loadRoute() {
  return await import('@/app/api/wiki-folders/[id]/sources/route');
}

beforeEach(() => {
  vi.mocked(getWikiFolder).mockReset();
  vi.mocked(createWikiSource).mockReset();
  vi.mocked(getEnvVarCreatedBy).mockReset();
});

describe('POST /api/wiki-folders/[id]/sources — patEnvRef ownership', () => {
  it('returns 403 when editor references another user PAT key', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(getEnvVarCreatedBy).mockResolvedValue('bob');

    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', {
      type: 'repo', name: 'src', repoUrl: 'https://github.com/x/y.git', patEnvRef: 'BOB_PAT',
    }, { username: 'alice', role: 'editor' }), { params });

    expect(res.status).toBe(403);
    expect(createWikiSource).not.toHaveBeenCalled();
  });

  it('returns 201 when editor uses their own PAT key', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(getEnvVarCreatedBy).mockResolvedValue('alice');
    vi.mocked(createWikiSource).mockResolvedValue({ id: 'new-source' } as any);

    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', {
      type: 'repo', name: 'src', repoUrl: 'https://github.com/x/y.git', patEnvRef: 'ALICE_PAT',
    }, { username: 'alice', role: 'editor' }), { params });

    expect(res.status).toBe(201);
  });

  it('admin bypasses patEnvRef ownership check', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(createWikiSource).mockResolvedValue({ id: 'new-source' } as any);

    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', {
      type: 'repo', name: 'src', repoUrl: 'https://github.com/x/y.git', patEnvRef: 'ANY_PAT',
    }, { username: 'admin-user', role: 'admin' }), { params });

    expect(res.status).toBe(201);
    expect(getEnvVarCreatedBy).not.toHaveBeenCalled();
  });

  it('does not check PAT ownership when patEnvRef is omitted', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(createWikiSource).mockResolvedValue({ id: 'new-source' } as any);

    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', {
      type: 'file', name: 'doc', content: 'hello',
    }, { username: 'alice', role: 'editor' }), { params });

    expect(res.status).toBe(201);
    expect(getEnvVarCreatedBy).not.toHaveBeenCalled();
  });
});
