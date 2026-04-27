/**
 * @fileoverview REST API route for the global MCP server catalog.
 *
 * GET  /api/mcps — List all MCP servers in the catalog
 * POST /api/mcps — Add a new MCP server to the catalog
 *
 * The MCP catalog is a platform-level resource. Any agent can use
 * any enabled MCP server. Managed via Settings → MCP Servers in the UI.
 *
 * @module web/api/mcps
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getAllMcpServers, createMcpServer } from '@/lib/db';
import type { UpsertMcpServerRequest } from '@slackhive/shared';
import { guardAdmin } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { maskMcpServer } from '@/lib/mcp-mask';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mcps
 * Returns all MCP servers in the global catalog, ordered by name.
 *
 * @returns {Promise<NextResponse>} JSON array of McpServer objects.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const servers = await getAllMcpServers();
    return NextResponse.json(servers.map(maskMcpServer));
  } catch (err) {
    return apiError('mcps', err);
  }
}

/**
 * POST /api/mcps
 * Adds a new MCP server to the global platform catalog.
 *
 * @param {NextRequest} request - Request body matching UpsertMcpServerRequest.
 * @returns {Promise<NextResponse>} The created McpServer (201), or error.
 *
 * @example
 * POST /api/mcps
 * {
 *   "name": "redshift-mcp",
 *   "type": "stdio",
 *   "config": { "command": "node", "args": ["/path/to/server.js"], "env": { "DATABASE_URL": "..." } },
 *   "description": "Redshift read-only query access"
 * }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(request);
  if (denied) return denied;
  try {
    const body = (await request.json()) as UpsertMcpServerRequest;

    if (!body.name || !body.type || !body.config) {
      return NextResponse.json(
        { error: 'name, type, and config are required' },
        { status: 400 }
      );
    }

    const session = getSessionFromRequest(request);
    const server = await createMcpServer(body, session?.username ?? 'admin');
    return NextResponse.json(server, { status: 201 });
  } catch (err) {
    if ((err as Error).message?.includes('unique')) {
      return NextResponse.json({ error: 'An MCP server with this name already exists' }, { status: 409 });
    }
    return apiError('mcps POST', err);
  }
}
