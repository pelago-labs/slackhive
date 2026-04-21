/**
 * @fileoverview Test-mode chat endpoint — proxies SSE from the runner.
 *
 * POST   /api/agents/[id]/test — run one test turn.
 *        Body: { sessionId: string, message: string }
 *        Streams SSE events straight through from the runner.
 * DELETE /api/agents/[id]/test — tear down a test session.
 *        Body: { sessionId: string }
 *
 * @module web/api/agents/[id]/test
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAgentById } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;

  const agent = await getAgentById(id);
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as
    | { sessionId?: string; message?: string; user?: string | null }
    | null;
  const sessionId = body?.sessionId;
  const message = (body?.message ?? '').trim();
  if (!sessionId || !message) {
    return NextResponse.json({ error: 'sessionId and message required' }, { status: 400 });
  }

  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  const upstream = await fetch(`http://127.0.0.1:${port}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: id, sessionId, message, user: body?.user ?? null }),
  }).catch((err: unknown) => {
    console.error('[api:agents/[id]/test] runner unreachable', err);
    return new Response(
      JSON.stringify({ error: 'runner unreachable' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => 'upstream failed');
    return new NextResponse(text, { status: upstream.status || 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as { sessionId?: string } | null;
  if (!body?.sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  }

  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  const upstream = await fetch(`http://127.0.0.1:${port}/test`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: id, sessionId: body.sessionId }),
  }).catch((err: unknown) => {
    console.error('[api:agents/[id]/test] runner unreachable', err);
    return new Response(
      JSON.stringify({ error: 'runner unreachable' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => 'upstream failed');
    return new NextResponse(text, { status: upstream.status || 502 });
  }
  return new NextResponse(null, { status: 204 });
}
