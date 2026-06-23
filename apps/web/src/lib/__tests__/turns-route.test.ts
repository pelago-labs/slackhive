/**
 * @fileoverview Tests for the /api/activity/turns route — auth gate (editors+ allowed,
 * viewers blocked) and the admin-only raw-sensitive rule: non-admins receive every
 * flagged value redacted server-side (via redactTurn), admins see raw.
 *
 * @module web/lib/__tests__/turns-route
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signSession } from '@/lib/auth';
import type { SessionPayload } from '@/lib/auth';
import type { Role } from '@/lib/auth-context';

const EMAIL = 'secret@acme.com';

vi.mock('@slackhive/shared', async () => {
  const actual = await vi.importActual<typeof import('@slackhive/shared')>('@slackhive/shared');
  const turn = {
    activityId: 'a1', agentId: 'ag', agentName: 'Atlas', agentSlug: 'atlas', status: 'done',
    startedAt: '2026-01-01 00:00:00', finishedAt: null, messagePreview: null, error: null,
    initiatorKind: 'user', initiatorHandle: 'u', delegatedByAgentName: null, delegatedByAgentSlug: null,
    durationMs: 10, inputTokens: 5, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    finalAnswer: `Email is ${EMAIL}`, sensitive: true, sensitiveCategories: ['pii:email'],
    feedback: [],
    spans: [{
      spanId: 's1', parentSpanId: null, kind: 'generation', name: 'gen', model: 'm', provider: null,
      startMs: 1, endMs: 2, durationMs: 1, status: 'ok', statusMessage: null, toolName: null,
      inputTokens: 5, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0, finishReason: null, input: null, output: `Email is ${EMAIL}`, reasoning: null,
      sensitive: true, sensitiveCategories: ['pii:email'], sensitiveReason: null, sensitiveSeverity: 'medium',
      sensitiveLlm: false, sensitiveLlmHits: [],
    }],
    sessionId: 'sess1', sessionSummary: 'hi',
  };
  return { ...actual, getTurnFeed: vi.fn().mockResolvedValue({ turns: [turn], nextCursor: null }) };
});

vi.mock('@/lib/db', () => ({ listAccessibleAgentIds: vi.fn() }));

import { listAccessibleAgentIds } from '@/lib/db';

const COOKIE_NAME = 'auth_session';
function requestAs(role: Role | null): Request {
  const url = 'http://localhost/api/activity/turns?window=24h';
  if (role === null) return new Request(url);
  const session: SessionPayload = { username: `user-${role}`, role };
  return new Request(url, { headers: { cookie: `${COOKIE_NAME}=${signSession(session)}` } });
}
async function loadRoute() { return await import('@/app/api/activity/turns/route'); }

beforeEach(() => { vi.mocked(listAccessibleAgentIds).mockReset().mockResolvedValue(null); });

describe('GET /api/activity/turns — auth + sensitive redaction', () => {
  it('401 without a session', async () => {
    const { GET } = await loadRoute();
    expect((await GET(requestAs(null) as any)).status).toBe(401);
  });

  it('403 for viewer', async () => {
    const { GET } = await loadRoute();
    expect((await GET(requestAs('viewer') as any)).status).toBe(403);
  });

  it('editor gets turns with sensitive values redacted server-side', async () => {
    vi.mocked(listAccessibleAgentIds).mockResolvedValue(['ag']);
    const { GET } = await loadRoute();
    const res = await GET(requestAs('editor') as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turns).toHaveLength(1);
    // The flagged email must NOT reach a non-admin in any field.
    expect(body.turns[0].finalAnswer).not.toContain(EMAIL);
    expect(body.turns[0].spans[0].output).not.toContain(EMAIL);
    // Extra feed fields survive redaction.
    expect(body.turns[0].sessionId).toBe('sess1');
    expect(body.turns[0].sessionSummary).toBe('hi');
  });

  it('admin sees raw sensitive values', async () => {
    const { GET } = await loadRoute();
    const res = await GET(requestAs('admin') as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turns[0].finalAnswer).toContain(EMAIL);
  });
});
