/**
 * @fileoverview Coach chat endpoints.
 *
 * POST   /api/agents/[id]/coach — run a coach turn.
 *        Body: { userMessage: string, attachment?: string,
 *                autoApply?: boolean, detached?: boolean }
 *        Default: proxies the runner's SSE stream straight to the browser.
 *        `detached: true` drains the runner in the background and returns 202
 *        immediately (used by the new-agent wizard so the user isn't blocked).
 *        `autoApply: true` tells the runner to apply proposals to the DB
 *        instead of queueing them as approval cards.
 * GET    /api/agents/[id]/coach — return the persisted session
 *        ({ messages, updatedAt? }).
 * DELETE /api/agents/[id]/coach — reset the session (overwrites with empty).
 * PATCH  /api/agents/[id]/coach — mark a proposal `applied` or `rejected`.
 *
 * @module web/api/agents/[id]/coach
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, getSetting, setSetting } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

const sessionKey = (agentId: string) => `coach-session:${agentId}`;

/** Stream a turn — proxies SSE from the runner. */
export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;

  const agent = await getAgentById(id);
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as
    | { userMessage?: string; attachment?: string; autoApply?: boolean; detached?: boolean }
    | null;
  const userMessage = (body?.userMessage ?? '').trim();
  if (!userMessage) {
    return NextResponse.json({ error: 'userMessage required' }, { status: 400 });
  }

  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  const upstream = await fetch(`http://127.0.0.1:${port}/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: id,
      userMessage,
      attachment: body?.attachment,
      autoApply: !!body?.autoApply,
    }),
  }).catch((err: unknown) => {
    return new Response(
      JSON.stringify({ error: `runner unreachable: ${(err as Error).message}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => 'upstream failed');
    return new NextResponse(text, { status: upstream.status || 502 });
  }

  // Detached mode: the client has already navigated away (wizard bootstrap).
  // Drain the runner's SSE body in the background so the turn completes and
  // persists its result to the session, then return 202 to the caller.
  if (body?.detached) {
    (async () => {
      try {
        const reader = upstream.body!.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch { /* runner closed — turn still completes server-side */ }
    })();
    return NextResponse.json({ status: 'started' }, { status: 202 });
  }

  // Default: pipe the SSE body straight through to the browser.
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

/** Return the persisted session. */
export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const raw = await getSetting(sessionKey(id));
  if (!raw) return NextResponse.json({ messages: [] });
  try {
    const parsed = JSON.parse(raw);
    return NextResponse.json({
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      updatedAt: parsed.updatedAt,
    });
  } catch {
    return NextResponse.json({ messages: [] });
  }
}

/** Reset the conversation. */
export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;
  // Overwrite with empty — avoids separate delete helper.
  await setSetting(sessionKey(id), JSON.stringify({ messages: [], updatedAt: new Date().toISOString() }));
  return new NextResponse(null, { status: 204 });
}

/**
 * Update a proposal's status after the user applies/rejects it.
 * Body: { proposalId: string, status: 'applied' | 'rejected' }
 */
export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as
    | { proposalId?: string; status?: 'applied' | 'rejected' }
    | null;
  if (!body?.proposalId || (body.status !== 'applied' && body.status !== 'rejected')) {
    return NextResponse.json({ error: 'proposalId and status required' }, { status: 400 });
  }

  const raw = await getSetting(sessionKey(id));
  if (!raw) return NextResponse.json({ error: 'no session' }, { status: 404 });
  const session = JSON.parse(raw);
  let hit = false;
  for (const msg of session.messages ?? []) {
    if (!Array.isArray(msg.proposals)) continue;
    for (const p of msg.proposals) {
      if (p.id === body.proposalId) { p.status = body.status; hit = true; }
    }
  }
  if (!hit) return NextResponse.json({ error: 'proposal not found' }, { status: 404 });
  session.updatedAt = new Date().toISOString();
  await setSetting(sessionKey(id), JSON.stringify(session));
  return new NextResponse(null, { status: 204 });
}
