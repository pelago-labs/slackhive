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
import { apiError } from '@/lib/api-error';
import { getMcpServerById, updateMcpServer, deleteMcpServer } from '@/lib/db';
import type { UpsertMcpServerRequest } from '@slackhive/shared';
import { guardAdmin } from '@/lib/api-guard';
import { maskMcpServer, mergeMcpConfig } from '@/lib/mcp-mask';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const server = await getMcpServerById(id);
    if (!server) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(maskMcpServer(server));
  } catch (err) {
    return apiError('mcps/[id]', err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = (await req.json()) as Partial<UpsertMcpServerRequest>;
    // If config is being updated, merge masked values with existing secrets
    if (body.config) {
      const existing = await getMcpServerById(id);
      if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      body.config = mergeMcpConfig(existing.config, body.config);
    }
    const updated = await updateMcpServer(id, body);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(maskMcpServer(updated));
  } catch (err) {
    return apiError('mcps/[id]', err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    await deleteMcpServer(id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return apiError('mcps/[id]', err);
  }
}
