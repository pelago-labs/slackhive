/**
 * @fileoverview POST /api/agents/[id]/analyze-memories — trigger memory analysis
 *               GET  /api/agents/[id]/analyze-memories?requestId=xxx — poll result
 *
 * Sends all memories + skills + system prompt to Claude for analysis.
 * Returns suggestions: move to skill, update prompt, merge, delete.
 *
 * @module web/api/agents/[id]/analyze-memories
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getAgentById, getSetting, setSetting, publishAgentEvent } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const agent = await getAgentById(id);
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  const requestId = randomUUID();
  await setSetting(`analyze:${requestId}`, JSON.stringify({ status: 'pending', agentId: id }));

  // Signal runner via internal HTTP
  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'analyze-memories', agentId: id, requestId }),
    });
  } catch { /* runner might not be running */ }

  return NextResponse.json({ requestId });
}

export async function GET(
  req: NextRequest,
): Promise<NextResponse> {
  const requestId = req.nextUrl.searchParams.get('requestId');
  if (!requestId) return NextResponse.json({ error: 'requestId required' }, { status: 400 });

  const raw = await getSetting(`analyze:${requestId}`);
  if (!raw) return NextResponse.json({ status: 'pending' });

  try {
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ status: 'error', error: 'Invalid data' });
  }
}
