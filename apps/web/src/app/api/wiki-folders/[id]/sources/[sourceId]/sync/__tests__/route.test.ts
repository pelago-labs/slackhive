import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  getWikiFolder: vi.fn(),
  getWikiSource: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

import { getWikiFolder, getWikiSource, getSetting, setSetting } from '@/lib/db';

const COOKIE = 'auth_session';

function makeFolder(overrides: Partial<{ id: string; createdBy: string }> = {}) {
  return { id: 'folder-1', name: 'Folder', createdBy: 'alice', createdAt: new Date(), updatedAt: new Date(), ...overrides };
}

function makeSource(overrides: Partial<{ id: string; folderId: string }> = {}) {
  return {
    id: 'source-1', folderId: 'folder-1', type: 'repo', name: 'src',
    repoUrl: 'https://github.com/x/y.git', branch: 'main', status: 'pending',
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeReq(method: string, session?: SessionPayload): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['cookie'] = `${COOKIE}=${signSession(session)}`;
  return new Request('http://localhost/api/wiki-folders/folder-1/sources/source-1/sync', {
    method, headers,
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: 'folder-1', sourceId: 'source-1' });

async function loadRoute() {
  return await import('@/app/api/wiki-folders/[id]/sources/[sourceId]/sync/route');
}

beforeEach(() => {
  vi.mocked(getWikiFolder).mockReset();
  vi.mocked(getWikiSource).mockReset();
  vi.mocked(getSetting).mockReset().mockResolvedValue(null);
  vi.mocked(setSetting).mockReset().mockResolvedValue(undefined as any);
});

describe('GET /api/wiki-folders/[id]/sources/[sourceId]/sync', () => {
  it('returns 401 when not authenticated', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET'), { params });
    expect(res.status).toBe(401);
  });

  it('returns idle status for any logged-in user', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq('GET', { username: 'bob', role: 'viewer' }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'idle' });
  });
});

describe('POST /api/wiki-folders/[id]/sources/[sourceId]/sync', () => {
  it('returns 401 when not authenticated', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST'), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when source belongs to a different folder (cross-folder rejection)', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ id: 'folder-1', createdBy: 'alice' }) as any);
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ id: 'source-1', folderId: 'folder-OTHER' }) as any);
    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 403 when editor does not own the folder', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ folderId: 'folder-1' }) as any);
    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', { username: 'bob', role: 'editor' }), { params });
    expect(res.status).toBe(403);
  });

  it('returns 200 when folder owner syncs source in their own folder', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ folderId: 'folder-1' }) as any);
    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 200 when admin syncs any source in correct folder', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ folderId: 'folder-1' }) as any);
    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', { username: 'admin-user', role: 'admin' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 404 when source does not exist', async () => {
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder() as any);
    vi.mocked(getWikiSource).mockResolvedValue(null);
    const { POST } = await loadRoute();
    const res = await POST(makeReq('POST', { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(404);
  });
});
