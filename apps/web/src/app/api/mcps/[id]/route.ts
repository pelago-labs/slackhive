/**
 * @fileoverview REST API route for a single MCP server resource.
 *
 * GET    /api/mcps/[id] — Get a specific MCP server
 * PATCH  /api/mcps/[id] — Update an MCP server
 * DELETE /api/mcps/[id] — Remove an MCP server from the catalog
 *
 * @module web/api/mcps/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMcpServerById, updateMcpServer, deleteMcpServer } from '@/lib/db';
import type { UpsertMcpServerRequest } from '@slack-agent-team/shared';

/**
 * GET /api/mcps/[id]
 * Returns a single MCP server by ID.
 *
 * @param {NextRequest} _request - Unused request object.
 * @param {{ params: { id: string } }} context - Route parameters.
 * @returns {Promise<NextResponse>} McpServer JSON or 404.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const server = await getMcpServerById(params.id);
    if (!server) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(server);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * PATCH /api/mcps/[id]
 * Updates an existing MCP server. Supports partial updates.
 *
 * @param {NextRequest} request - Partial UpsertMcpServerRequest body.
 * @param {{ params: { id: string } }} context - Route parameters.
 * @returns {Promise<NextResponse>} Updated McpServer or 404.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Partial<UpsertMcpServerRequest>;
    const updated = await updateMcpServer(params.id, body);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * DELETE /api/mcps/[id]
 * Removes an MCP server from the catalog.
 * Also removes all agent_mcps associations (via CASCADE).
 * Note: any affected running agents should be reloaded after this.
 *
 * @param {NextRequest} _request - Unused.
 * @param {{ params: { id: string } }} context - Route parameters.
 * @returns {Promise<NextResponse>} 204 No Content on success.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    await deleteMcpServer(params.id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
