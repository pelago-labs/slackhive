/**
 * @fileoverview MCP tool inventory endpoint with on-DB caching.
 *
 * GET /api/mcps/[id]/tools[?refresh=1]
 *
 * Returns the cached tool list for an MCP. On cache miss (or `?refresh=1`,
 * or cache older than TTL_MS), performs a fresh MCP handshake via
 * `listMcpTools` and persists the result into `mcp_servers.tool_list_cache`.
 *
 * The case-editor in the Evals tab calls this when the user picks an MCP
 * server in the two-step tool picker.
 *
 * @module web/api/mcps/[id]/tools
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAuth } from '@/lib/api-guard';
import { getMcpServerById, setMcpToolsCache } from '@/lib/db';
import { listMcpTools } from '@/lib/mcp/list-tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

/** Cache TTL — 24 hours. Reasonable balance between freshness and connect cost. */
const TTL_MS = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const denied = guardAuth(req);
    if (denied) return denied;

    const { id } = await params;
    const server = await getMcpServerById(id);
    if (!server) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    const url = new URL(req.url);
    const force = url.searchParams.get('refresh') === '1';

    const cached = server.toolListCache ?? null;
    const cachedAtMs = server.toolListCachedAt ? new Date(server.toolListCachedAt).getTime() : null;
    const fresh = cachedAtMs !== null && Date.now() - cachedAtMs < TTL_MS;

    if (cached && fresh && !force) {
      return NextResponse.json({
        tools: cached,
        cachedAt: new Date(cachedAtMs!).toISOString(),
        source: 'cache',
      });
    }

    // Cache miss / stale / forced — hit the MCP.
    const result = await listMcpTools(server);

    if (!result.ok) {
      // On failure, fall back to the stale cache if we have one — better
      // than nothing for the dropdown. Otherwise return the error.
      if (cached) {
        return NextResponse.json({
          tools: cached,
          cachedAt: cachedAtMs ? new Date(cachedAtMs).toISOString() : null,
          source: 'stale',
          error: result.error,
        });
      }
      return NextResponse.json({ error: result.error ?? 'MCP handshake failed' }, { status: 502 });
    }

    await setMcpToolsCache(server.id, result.tools);
    return NextResponse.json({
      tools: result.tools,
      cachedAt: new Date().toISOString(),
      source: 'fresh',
      toolsListUnsupported: result.toolsListUnsupported ?? false,
    });
  } catch (err) {
    return apiError('mcps/[id]/tools:GET', err);
  }
}
