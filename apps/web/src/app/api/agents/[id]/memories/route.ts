/**
 * @fileoverview REST API routes for agent memories.
 *
 * GET  /api/agents/[id]/memories — List all memories for an agent
 * POST /api/agents/[id]/memories — Create or update a memory entry
 *
 * @module web/api/agents/[id]/memories
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentMemories, upsertMemory } from '@/lib/db';
import type { UpsertMemoryRequest } from '@slackhive/shared';
import { guardAdmin } from '@/lib/api-guard';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/agents/[id]/memories
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} JSON array of Memory objects.
 */
export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const memories = await getAgentMemories(id);
    return NextResponse.json(memories);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/agents/[id]/memories
 * Creates or updates a memory entry.
 *
 * @param {NextRequest} req - Body: UpsertMemoryRequest
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} The upserted Memory or error.
 */
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = (await req.json()) as UpsertMemoryRequest;
    if (!body.type || !body.name || !body.content) {
      return NextResponse.json({ error: 'type, name, content are required' }, { status: 400 });
    }
    const memory = await upsertMemory(id, body.type, body.name, body.content);
    return NextResponse.json(memory, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
