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
import { getAgentById, getSetting, setSetting, deleteSetting } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

const sessionKey = (agentId: string) => `coach-session:${agentId}`;
/**
 * Queue of proposal-action notes ("User applied your proposal: …"). PATCH
 * pushes to this list; the next POST drains it and prepends a `[Context …]`
 * block to the user's real message before forwarding to the runner.
 *
 * Why this exists: the SDK resumes via `resume: sdkSessionId`, so the model's
 * history lives inside the SDK session. `session.messages` is only the UI
 * transcript — `runCoachTurn` does not replay it to the model. Apply/Reject
 * happen between turns, so without this queue the model never learns the user
 * acted on a proposal.
 */
const notesKey = (agentId: string) => `coach-notes:${agentId}`;
/** Rolling buffer of archived conversations (most recent first, capped at 10). */
const archiveKey = (agentId: string) => `coach-archive:${agentId}`;
const ARCHIVE_CAP = 10;

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

  // Drain any pending proposal-action notes left by PATCH and prepend them to
  // the user's real message. This is how the model learns about Apply/Reject
  // clicks that happened outside the turn loop (see notesKey docstring).
  let augmentedMessage = userMessage;
  const notesRaw = await getSetting(notesKey(id));
  if (notesRaw) {
    try {
      const notes = JSON.parse(notesRaw);
      if (Array.isArray(notes) && notes.length) {
        const bullets = (notes as string[]).map(n => `- ${n}`).join('\n');
        augmentedMessage = `[Context since your last message:\n${bullets}]\n\n${userMessage}`;
      }
    } catch { /* malformed — drop silently */ }
    await deleteSetting(notesKey(id));
  }

  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  const upstream = await fetch(`http://127.0.0.1:${port}/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: id,
      userMessage: augmentedMessage,
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

/**
 * Return the persisted session. With `?archive=1`, returns archived
 * conversations instead (used by the History view). The archive payload
 * contains the full messages for each entry so the UI can render a
 * read-only view without a second round-trip.
 */
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  if (new URL(req.url).searchParams.get('archive') === '1') {
    const raw = await getSetting(archiveKey(id));
    if (!raw) return NextResponse.json({ archive: [] });
    try {
      const parsed = JSON.parse(raw);
      return NextResponse.json({ archive: Array.isArray(parsed) ? parsed : [] });
    } catch {
      return NextResponse.json({ archive: [] });
    }
  }

  const raw = await getSetting(sessionKey(id));
  if (!raw) return NextResponse.json({ messages: [] });
  try {
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

    // Heal stale `inProgress: true` rows. If the runner was killed mid-turn
    // (crash, `slackhive stop && start`), the draft message stays inProgress
    // forever and blocks the composer. After STALE_MS any in-progress draft
    // is treated as abandoned — the UI then shows a usable tail message.
    const STALE_MS = 30_000;
    let mutated = false;
    const now = Date.now();
    for (const m of messages) {
      if (m?.role === 'assistant' && m.inProgress &&
          now - new Date(m.createdAt).getTime() > STALE_MS) {
        m.inProgress = false;
        if (!m.text) m.text = '_Draft abandoned — runner restarted. Try again._';
        mutated = true;
      }
    }
    if (mutated) {
      await setSetting(sessionKey(id), JSON.stringify({ ...parsed, messages, updatedAt: new Date().toISOString() }));
    }

    return NextResponse.json({ messages, updatedAt: parsed.updatedAt });
  } catch {
    return NextResponse.json({ messages: [] });
  }
}

/**
 * Start a new conversation. Non-destructive: archives the current active
 * session into `coach-archive:<id>` (rolling buffer, most recent first,
 * capped at {@link ARCHIVE_CAP}) before clearing the active row and any
 * pending proposal-action notes. The next POST opens a fresh SDK session.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;

  const activeRaw = await getSetting(sessionKey(id));
  if (activeRaw) {
    try {
      const parsed = JSON.parse(activeRaw);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      // Skip archiving empty threads — no point keeping a row with nothing in it.
      if (messages.length > 0) {
        const archiveRaw = await getSetting(archiveKey(id));
        let archive: unknown[] = [];
        if (archiveRaw) {
          try {
            const parsedArchive = JSON.parse(archiveRaw);
            if (Array.isArray(parsedArchive)) archive = parsedArchive;
          } catch { /* ignore malformed; start fresh */ }
        }
        archive.unshift({
          id: crypto.randomUUID(),
          sdkSessionId: parsed.sdkSessionId,
          messages,
          startedAt: messages[0]?.createdAt ?? new Date().toISOString(),
          archivedAt: new Date().toISOString(),
        });
        await setSetting(archiveKey(id), JSON.stringify(archive.slice(0, ARCHIVE_CAP)));
      }
    } catch { /* active row malformed — still clear it below */ }
  }

  await deleteSetting(sessionKey(id));
  // Drop any orphan notes so they don't bleed into the new conversation.
  await deleteSetting(notesKey(id));
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
  let hit: { kind: string; action?: string; category?: string; filename?: string; memoryName?: string; memoryType?: string } | null = null;
  for (const msg of session.messages ?? []) {
    if (!Array.isArray(msg.proposals)) continue;
    for (const p of msg.proposals) {
      if (p.id === body.proposalId) {
        p.status = body.status;
        hit = {
          kind: p.kind, action: p.action,
          category: p.category, filename: p.filename,
          memoryName: p.memoryName,
          memoryType: p.memoryType,
        };
      }
    }
  }
  if (!hit) return NextResponse.json({ error: 'proposal not found' }, { status: 404 });

  // Persist the UI-only status flip.
  session.updatedAt = new Date().toISOString();
  await setSetting(sessionKey(id), JSON.stringify(session));

  // Enqueue a note for the next turn so the model learns Apply/Reject happened.
  // The earlier implementation pushed a `hidden: true` message into
  // `session.messages` — that worked for the UI but never reached the LLM,
  // because `runCoachTurn` resumes via `sdkSessionId` and only forwards the
  // latest `userMessage`. A POST-side queue-drain (see above) fixes that by
  // riding the next real user message.
  const label = hit.kind === 'claude-md'
    ? 'CLAUDE.md update'
    : hit.kind === 'memory'
      ? `memory ${hit.action} ${hit.memoryName}${hit.memoryType ? ` (${hit.memoryType})` : ''}`
      : `skill ${hit.action} ${hit.category}/${hit.filename}`;
  const prevNotesRaw = await getSetting(notesKey(id));
  let notes: string[] = [];
  if (prevNotesRaw) {
    try {
      const parsed = JSON.parse(prevNotesRaw);
      if (Array.isArray(parsed)) notes = parsed as string[];
    } catch { /* ignore malformed */ }
  }
  notes.push(`User ${body.status} your proposal: ${label}.`);
  await setSetting(notesKey(id), JSON.stringify(notes));

  return new NextResponse(null, { status: 204 });
}
