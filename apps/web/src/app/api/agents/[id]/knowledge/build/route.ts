/**
 * @fileoverview POST /api/agents/[id]/knowledge/build — trigger wiki compilation
 *               GET  /api/agents/[id]/knowledge/build?requestId=xxx — poll result
 *
 * @module web/api/agents/[id]/knowledge/build
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { setSetting, getSetting, publishAgentEvent } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const requestId = randomUUID();

  // Optional: sync a single source
  let sourceId: string | undefined;
  try {
    const body = await req.json();
    sourceId = body.sourceId;
  } catch { /* no body = build all pending */ }

  await setSetting(`knowledge-build:${requestId}`, JSON.stringify({ status: 'pending', agentId: id, startedAt: Date.now() }));
  await setSetting(`knowledge-build-latest:${id}`, requestId);

  // Signal runner via internal HTTP
  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  try {
    const eventType = sourceId ? 'ingest-source' : 'build-knowledge';
    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: eventType, agentId: id, sourceId, requestId }),
    });
  } catch { /* runner might not be running */ }

  return NextResponse.json({ requestId });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  let requestId = req.nextUrl.searchParams.get('requestId');

  // If no requestId, check the latest build for this agent
  if (!requestId) {
    const { id } = await params;
    const latestId = await getSetting(`knowledge-build-latest:${id}`);
    if (!latestId) return NextResponse.json({ status: 'none' });
    requestId = latestId;
  }

  const raw = await getSetting(`knowledge-build:${requestId}`);
  if (!raw) return NextResponse.json({ status: 'pending', requestId });

  try {
    const data = JSON.parse(raw);
    // startedAt is updated on every step — treat it as "last progress" timestamp.
    // If no progress for 20 min, consider the build crashed.
    // (Single Claude call can take ~10 min for large repos; 20 min safety margin)
    if ((data.status === 'pending' || data.status === 'building') && data.startedAt) {
      const sinceLastUpdate = Date.now() - data.startedAt;
      if (sinceLastUpdate > 20 * 60 * 1000) {
        return NextResponse.json({
          status: 'error',
          error: `No progress for ${Math.round(sinceLastUpdate / 60000)} minutes — the process may have crashed. Try again.`,
          requestId,
        });
      }
    }
    return NextResponse.json({ ...data, requestId });
  } catch { return NextResponse.json({ status: 'error', error: 'Invalid data' }); }
}
