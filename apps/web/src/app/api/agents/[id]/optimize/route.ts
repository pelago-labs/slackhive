/**
 * @fileoverview POST /api/agents/[id]/optimize — trigger instruction optimization
 *               GET  /api/agents/[id]/optimize?requestId=xxx — poll for result
 *
 * POSTs optimize event to the runner's internal HTTP server.
 * Runner calls Claude SDK and stores result in DB for polling.
 *
 * @module web/api/agents/[id]/optimize
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getAgentById, getSetting, setSetting, getAllSettings, publishAgentEvent } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST — trigger optimization.
 * Returns { requestId } that the client uses to poll for results.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const agent = await getAgentById(id);
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  const requestId = randomUUID();

  // Cancel any previous pending/running optimize requests for this agent
  const allSettings = await getAllSettings();
  for (const [key, value] of Object.entries(allSettings)) {
    if (key.startsWith('optimize:')) {
      try {
        const data = JSON.parse(value);
        if (data.agentId === id && (data.status === 'pending' || data.status === 'running')) {
          await setSetting(key, JSON.stringify({ ...data, status: 'cancelled' }));
        }
      } catch { /* skip */ }
    }
  }

  // Store initial status for polling + track latest per agent
  await setSetting(`optimize:${requestId}`, JSON.stringify({ status: 'pending', agentId: id }));
  await setSetting(`optimize-latest:${id}`, requestId);

  // Send directly to runner's internal HTTP server
  await publishAgentEvent({ type: 'optimize', agentId: id, requestId });

  return NextResponse.json({ requestId });
}

/**
 * GET — poll for optimization result.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  let requestId = req.nextUrl.searchParams.get('requestId');

  // If no requestId, check the latest for this agent
  if (!requestId) {
    const { id } = await params;
    const latestId = await getSetting(`optimize-latest:${id}`);
    if (!latestId) return NextResponse.json({ status: 'none' });
    requestId = latestId;
  }

  const raw = await getSetting(`optimize:${requestId}`);
  if (!raw) return NextResponse.json({ status: 'pending', requestId });

  try {
    return NextResponse.json({ ...JSON.parse(raw), requestId });
  } catch {
    return NextResponse.json({ status: 'error', error: 'Invalid result data' });
  }
}
