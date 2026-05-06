import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  getWikiSource: vi.fn(),
  getWikiFolder: vi.fn(),
  updateWikiSource: vi.fn(),
  deleteWikiSource: vi.fn(),
  getEnvVarCreatedBy: vi.fn(),
}));

import { getWikiSource, getWikiFolder, updateWikiSource, deleteWikiSource, getEnvVarCreatedBy } from '@/lib/db';

const COOKIE = 'auth_session';

function makeFolder(overrides: Partial<{ id: string; createdBy: string }> = {}) {
  return { id: 'folder-1', name: 'Folder', createdBy: 'alice', createdAt: new Date(), updatedAt: new Date(), ...overrides };
}

function makeSource(overrides: Partial<{ id: string; folderId: string; type: string; status: string }> = {}) {
  return {
    id: 'source-1', folderId: 'folder-1', type: 'repo', name: 'src',
    repoUrl: 'https://github.com/x/y.git', branch: 'main', status: 'compiled',
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeReq(method: string, body?: unknown, session?: SessionPayload): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['cookie'] = `${COOKIE}=${signSession(session)}`;
  return new Request('http://localhost/api/wiki-folders/folder-1/sources/source-1', {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: 'folder-1', sourceId: 'source-1' });

async function loadRoute() {
  return await import('@/app/api/wiki-folders/[id]/sources/[sourceId]/route');
}

beforeEach(() => {
  vi.mocked(getWikiSource).mockReset();
  vi.mocked(getWikiFolder).mockReset();
  vi.mocked(updateWikiSource).mockReset();
  vi.mocked(deleteWikiSource).mockReset();
  vi.mocked(getEnvVarCreatedBy).mockReset();
});

describe('PATCH/DELETE /api/wiki-folders/[id]/sources/[sourceId] — URL folder must match source folder', () => {
  it('PATCH returns 404 when source belongs to a different folder', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ folderId: 'folder-OTHER' }) as any);
    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { name: 'x' }, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(404);
  });

  it('DELETE returns 404 when source belongs to a different folder', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ folderId: 'folder-OTHER' }) as any);
    const { DELETE } = await loadRoute();
    const res = await DELETE(makeReq('DELETE', undefined, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/wiki-folders/[id]/sources/[sourceId] — stale marking on repo field changes', () => {
  it('marks compiled repo source stale when repoUrl changes', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ type: 'repo', status: 'compiled' }) as any);
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(updateWikiSource).mockImplementation(async (_id, body) => ({ ...makeSource(), ...body }) as any);

    const { PATCH } = await loadRoute();
    await PATCH(makeReq('PATCH', { repoUrl: 'https://github.com/x/new.git' }, { username: 'alice', role: 'editor' }), { params });

    expect(updateWikiSource).toHaveBeenCalledWith('source-1', expect.objectContaining({ status: 'stale' }));
  });

  it('marks compiled repo source stale when branch changes', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ type: 'repo', status: 'compiled' }) as any);
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(updateWikiSource).mockImplementation(async (_id, body) => ({ ...makeSource(), ...body }) as any);

    const { PATCH } = await loadRoute();
    await PATCH(makeReq('PATCH', { branch: 'develop' }, { username: 'alice', role: 'editor' }), { params });

    expect(updateWikiSource).toHaveBeenCalledWith('source-1', expect.objectContaining({ status: 'stale' }));
  });

  it('marks compiled repo source stale when patEnvRef changes', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ type: 'repo', status: 'compiled' }) as any);
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(getEnvVarCreatedBy).mockResolvedValue('alice');
    vi.mocked(updateWikiSource).mockImplementation(async (_id, body) => ({ ...makeSource(), ...body }) as any);

    const { PATCH } = await loadRoute();
    await PATCH(makeReq('PATCH', { patEnvRef: 'GITHUB_PAT' }, { username: 'alice', role: 'editor' }), { params });

    expect(updateWikiSource).toHaveBeenCalledWith('source-1', expect.objectContaining({ status: 'stale' }));
  });

  it('does NOT mark stale when name-only update on compiled source', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ type: 'repo', status: 'compiled' }) as any);
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(updateWikiSource).mockImplementation(async (_id, body) => ({ ...makeSource(), ...body }) as any);

    const { PATCH } = await loadRoute();
    await PATCH(makeReq('PATCH', { name: 'renamed' }, { username: 'alice', role: 'editor' }), { params });

    expect(updateWikiSource).toHaveBeenCalledWith('source-1', expect.not.objectContaining({ status: 'stale' }));
  });

  it('does NOT mark stale when source is not yet compiled', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource({ type: 'repo', status: 'pending' }) as any);
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(updateWikiSource).mockImplementation(async (_id, body) => ({ ...makeSource(), ...body }) as any);

    const { PATCH } = await loadRoute();
    await PATCH(makeReq('PATCH', { repoUrl: 'https://github.com/x/new.git' }, { username: 'alice', role: 'editor' }), { params });

    expect(updateWikiSource).toHaveBeenCalledWith('source-1', expect.not.objectContaining({ status: 'stale' }));
  });
});

describe('PATCH /api/wiki-folders/[id]/sources/[sourceId] — patEnvRef ownership', () => {
  it('returns 403 when editor references another user PAT key', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource() as any);
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(getEnvVarCreatedBy).mockResolvedValue('bob');

    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { patEnvRef: 'BOB_PAT' }, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(403);
    expect(updateWikiSource).not.toHaveBeenCalled();
  });

  it('returns 200 when editor uses their own PAT key', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource() as any);
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(getEnvVarCreatedBy).mockResolvedValue('alice');
    vi.mocked(updateWikiSource).mockResolvedValue(makeSource() as any);

    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { patEnvRef: 'ALICE_PAT' }, { username: 'alice', role: 'editor' }), { params });
    expect(res.status).toBe(200);
  });

  it('admin bypasses patEnvRef ownership check', async () => {
    vi.mocked(getWikiSource).mockResolvedValue(makeSource() as any);
    vi.mocked(getWikiFolder).mockResolvedValue(makeFolder({ createdBy: 'alice' }) as any);
    vi.mocked(updateWikiSource).mockResolvedValue(makeSource() as any);

    const { PATCH } = await loadRoute();
    const res = await PATCH(makeReq('PATCH', { patEnvRef: 'ANY_PAT' }, { username: 'admin-user', role: 'admin' }), { params });
    expect(res.status).toBe(200);
    expect(getEnvVarCreatedBy).not.toHaveBeenCalled();
  });
});
