/**
 * @fileoverview MCP server connectivity test endpoint.
 *
 * POST /api/mcps/[id]/test
 *
 * Thin wrapper around `listMcpTools` (apps/web/src/lib/mcp/list-tools.ts) —
 * the same handshake powers GET /api/mcps/[id]/tools, which populates the
 * case-editor tool dropdown.
 *
 * External response shape unchanged: { ok, message?, error?, tools?: string[] }.
 *
 * @module web/api/mcps/[id]/test
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMcpServerById } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { listMcpTools } from '@/lib/mcp/list-tools';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/mcps/[id]/test
 * Runs a quick connectivity check against the MCP server.
 *
 * @returns { ok: true, message, tools? } or { ok: false, error }
 */
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  // Test is read-only against the MCP definition (spawns the server, runs an MCP
  // handshake, then kills it — no DB mutation). Any editor / admin / superadmin
  // can trigger it from the MCPs settings page regardless of who owns the row;
  // viewers stay blocked.
  const denied = guardAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const server = await getMcpServerById(id);
  if (!server) {
    return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
  }

  try {
    const result = await listMcpTools(server);

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error });
    }

    const reportedName = result.serverName ?? server.name;
    if (result.toolsListUnsupported) {
      return NextResponse.json({
        ok: true,
        message: `Connected to "${reportedName}" — tools/list unsupported`,
      });
    }
    const tools = result.tools.map((t) => t.name);
    const suffix =
      tools.length === 0 ? 'no tools exposed' : `${tools.length} tool${tools.length === 1 ? '' : 's'} available`;
    return NextResponse.json({
      ok: true,
      message: `Connected to "${reportedName}" — ${suffix}`,
      tools,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message });
  }
}
