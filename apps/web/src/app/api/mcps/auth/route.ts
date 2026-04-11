/**
 * @fileoverview POST /api/mcps/auth
 * Triggers MCP authentication via Claude Code SDK.
 *
 * For MCPs like Figma that block dynamic client registration,
 * the Claude Code SDK has pre-registered OAuth credentials.
 * This endpoint asks the runner to initiate a Claude SDK session
 * with the MCP server, which triggers the SDK's built-in OAuth flow
 * (opens browser for auth on the host machine).
 *
 * Body: { mcpUrl: string, mcpName: string, templateId: string }
 * Returns: { status: 'started' | 'error', message?: string }
 *
 * @module web/api/mcps/auth
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { setSetting, publishAgentEvent } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { mcpUrl, mcpName, templateId } = await req.json();

  if (!mcpUrl || !mcpName) {
    return NextResponse.json({ error: 'mcpUrl and mcpName required' }, { status: 400 });
  }

  const requestId = randomUUID();

  // Store the auth request for the runner to pick up
  await setSetting(`mcp_auth:${requestId}`, JSON.stringify({
    status: 'pending',
    mcpUrl,
    mcpName,
    templateId,
  }));

  // Signal the runner via internal HTTP server
  try {
    const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mcp-auth', requestId, mcpUrl, mcpName }),
    });
  } catch {
    return NextResponse.json({ error: 'Runner not available' }, { status: 503 });
  }

  return NextResponse.json({ requestId, status: 'started' });
}

/**
 * GET /api/mcps/auth?requestId=xxx — poll for auth result
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = req.nextUrl.searchParams.get('requestId');
  if (!requestId) {
    return NextResponse.json({ error: 'requestId required' }, { status: 400 });
  }

  const { getSetting } = await import('@/lib/db');
  const raw = await getSetting(`mcp_auth:${requestId}`);
  if (!raw) return NextResponse.json({ status: 'pending' });

  try {
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ status: 'error', error: 'Invalid data' });
  }
}
