/**
 * @fileoverview Tests for the coach chat API route.
 *
 * Covers the non-streaming paths:
 * - GET returns empty when no session exists; parses persisted sessions
 * - DELETE clears the session
 * - PATCH updates a proposal's status in the persisted transcript
 *
 * POST streams SSE from the runner — exercised in UI integration rather than
 * here, to avoid mocking the runner HTTP server.
 *
 * @module web/lib/__tests__/coach-route
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';

vi.mock('@/lib/db', () => ({
  getAgentById: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
  publishAgentEvent: vi.fn(),
}));

vi.mock('@/lib/api-guard', () => ({
  guardAgentWrite: vi.fn(),
}));

import { getAgentById, getSetting, setSetting, deleteSetting } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

const COOKIE_NAME = 'auth_session';
const session: SessionPayload = { username: 'admin', role: 'admin' };
function authHeaders() { return { cookie: `${COOKIE_NAME}=${signSession(session)}` }; }

beforeEach(() => {
  vi.mocked(getAgentById).mockReset().mockResolvedValue({ id: 'a1', name: 'x' } as any);
  vi.mocked(getSetting).mockReset().mockResolvedValue(null);
  vi.mocked(setSetting).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteSetting).mockReset().mockResolvedValue(undefined);
  vi.mocked(guardAgentWrite).mockReset().mockResolvedValue(null as any);
});

async function loadRoute() {
  return await import('@/app/api/agents/[id]/coach/route');
}

describe('GET /api/agents/[id]/coach', () => {
  it('returns empty messages when no session is stored', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request('http://localhost') as any, { params: Promise.resolve({ id: 'a1' }) });
    const body = await res.json();
    expect(body).toEqual({ messages: [] });
  });

  it('returns persisted messages when session exists', async () => {
    const stored = {
      messages: [{ id: 'm1', role: 'user', text: 'hi', createdAt: '2020-01-01' }],
      updatedAt: '2020-01-01',
    };
    vi.mocked(getSetting).mockResolvedValueOnce(JSON.stringify(stored));
    const { GET } = await loadRoute();
    const res = await GET(new Request('http://localhost') as any, { params: Promise.resolve({ id: 'a1' }) });
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].text).toBe('hi');
  });

  it('tolerates malformed session JSON', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('{not-json');
    const { GET } = await loadRoute();
    const res = await GET(new Request('http://localhost') as any, { params: Promise.resolve({ id: 'a1' }) });
    const body = await res.json();
    expect(body).toEqual({ messages: [] });
  });
});

describe('DELETE /api/agents/[id]/coach', () => {
  it('deletes the session and orphan notes settings', async () => {
    const { DELETE } = await loadRoute();
    const res = await DELETE(
      new Request('http://localhost', { method: 'DELETE', headers: authHeaders() }) as any,
      { params: Promise.resolve({ id: 'a1' }) },
    );
    expect(res.status).toBe(204);
    const deletedKeys = vi.mocked(deleteSetting).mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain('coach-session:a1');
  });
});

describe('PATCH /api/agents/[id]/coach', () => {
  it('updates the status of a matching proposal', async () => {
    const stored = {
      messages: [
        {
          id: 'm1', role: 'assistant', text: 'ok', createdAt: 'x',
          proposals: [
            { kind: 'claude-md', id: 'p1', content: 'new', rationale: 'r', status: 'pending' },
            { kind: 'skill', id: 'p2', category: 'c', filename: 'f.md', action: 'create', content: 'x', rationale: 'r', status: 'pending' },
          ],
        },
      ],
    };
    vi.mocked(getSetting).mockResolvedValueOnce(JSON.stringify(stored));

    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ proposalId: 'p1', status: 'applied' }),
      }) as any,
      { params: Promise.resolve({ id: 'a1' }) },
    );
    expect(res.status).toBe(204);

    const written = vi.mocked(setSetting).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    const proposals = parsed.messages[0].proposals;
    expect(proposals[0].status).toBe('applied');
    expect(proposals[1].status).toBe('pending');
  });

  it('rejects bad bodies with 400', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ proposalId: 'p1' }),
      }) as any,
      { params: Promise.resolve({ id: 'a1' }) },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when no session exists', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ proposalId: 'p1', status: 'applied' }),
      }) as any,
      { params: Promise.resolve({ id: 'a1' }) },
    );
    expect(res.status).toBe(404);
  });
});
