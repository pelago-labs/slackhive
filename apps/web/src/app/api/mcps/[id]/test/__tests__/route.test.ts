/**
 * @fileoverview Tests for the MCP "Test connection" auth gate.
 *
 * History: this endpoint used to require "MCP owner OR admin/superadmin",
 * which blocked editors who happened not to own the row. Test is read-only
 * (handshake + kill, no DB write), so any editor-or-above on the MCP
 * settings page is now allowed; viewers stay blocked.
 *
 * The handshake itself is exercised by manual / staging tests — these tests
 * mock the spawn / fetch path away and pin only the auth + 404 behavior.
 *
 * @module web/api/mcps/[id]/test/__tests__/route.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  getMcpServerById: vi.fn(),
  getEnvVarValues: vi.fn(async () => ({})),
}));

// Stub out child_process / fetch so the test doesn't actually spawn anything.
// We only care about the auth gate + 404 path here.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn() },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === 'exit') setImmediate(() => cb(1));
    }),
    kill: vi.fn(),
  })),
}));

import { getMcpServerById } from '@/lib/db';

const COOKIE = 'auth_session';

const aliceOwner: SessionPayload = { username: 'alice', role: 'editor' };       // owner + editor
const bobOtherEditor: SessionPayload = { username: 'bob', role: 'editor' };     // editor, NOT owner — was blocked, must now pass
const carolViewer: SessionPayload = { username: 'carol', role: 'viewer' };      // viewer — must stay blocked
const adminSession: SessionPayload = { username: 'root', role: 'admin' };

function makeReq(session?: SessionPayload): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['cookie'] = `${COOKIE}=${signSession(session)}`;
  return new Request('http://localhost/api/mcps/mcp-1/test', {
    method: 'POST',
    headers,
    body: '{}',
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'mcp-1' }) };

function ownedBy(username: string) {
  return {
    id: 'mcp-1',
    name: 'Test MCP',
    type: 'stdio' as const,
    config: { command: 'true', args: [] },
    createdBy: username,
    enabled: true,
    description: '',
    createdAt: new Date(),
  };
}

beforeEach(() => {
  vi.mocked(getMcpServerById).mockReset();
});

describe('POST /api/mcps/[id]/test — auth gate', () => {
  it('returns 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/mcps/[id]/test/route');
    const res = await POST(makeReq() as NextRequest, params);
    expect(res.status).toBe(401);
    expect(getMcpServerById).not.toHaveBeenCalled();
  });

  it('returns 403 for viewer (read-only role must not trigger spawn)', async () => {
    const { POST } = await import('@/app/api/mcps/[id]/test/route');
    const res = await POST(makeReq(carolViewer) as NextRequest, params);
    expect(res.status).toBe(403);
    expect(getMcpServerById).not.toHaveBeenCalled();
  });

  it('returns 404 when the MCP id does not exist (after auth passes)', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(null as any);
    const { POST } = await import('@/app/api/mcps/[id]/test/route');
    const res = await POST(makeReq(adminSession) as NextRequest, params);
    expect(res.status).toBe(404);
  });

  it('allows the MCP owner (editor + creator) to test', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(ownedBy('alice') as any);
    const { POST } = await import('@/app/api/mcps/[id]/test/route');
    const res = await POST(makeReq(aliceOwner) as NextRequest, params);
    // Got past the auth gate (200 from the test exit-1 path is fine — point is no 401/403)
    expect([200, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('allows an editor who is NOT the owner to test (the regression fix)', async () => {
    // Pre-fix: this returned 403. Post-fix: editor-or-above always passes.
    vi.mocked(getMcpServerById).mockResolvedValue(ownedBy('alice') as any);
    const { POST } = await import('@/app/api/mcps/[id]/test/route');
    const res = await POST(makeReq(bobOtherEditor) as NextRequest, params);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('allows admin even when not the owner', async () => {
    vi.mocked(getMcpServerById).mockResolvedValue(ownedBy('alice') as any);
    const { POST } = await import('@/app/api/mcps/[id]/test/route');
    const res = await POST(makeReq(adminSession) as NextRequest, params);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
