/**
 * @fileoverview REST API routes for agent snapshot collection.
 *
 * GET  /api/agents/[id]/snapshots — List all snapshots for an agent
 * POST /api/agents/[id]/snapshots — Create a manual snapshot
 *
 * @module web/api/agents/[id]/snapshots
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import {
  getAgentById,
  getAgentSkills,
  getAgentPermissions,
  getAgentMcpServers,
  listSnapshots,
  createSnapshot,
} from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { skillToSnapshotSkill } from '@/lib/compile';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/[id]/snapshots
 * Returns all snapshots for an agent, newest first.
 *
 * @returns {Promise<NextResponse>} JSON array of AgentSnapshot objects.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const snapshots = await listSnapshots(id);
    // Omit compiledMd from list view to keep payload small
    return NextResponse.json(snapshots.map(s => ({ ...s, compiledMd: undefined })));
  } catch (err) {
    return apiError('agents/[id]/snapshots', err);
  }
}

/**
 * POST /api/agents/[id]/snapshots
 * Creates a manual snapshot of the agent's current configuration.
 *
 * @param {NextRequest} request - Body: { label?: string }
 * @returns {Promise<NextResponse>} The created AgentSnapshot (201).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = await guardAgentWrite(request, id);
    if (denied) return denied;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const label: string | null = body.label ?? null;

    const session = getSessionFromRequest(request);
    const [skills, perms, mcps] = await Promise.all([
      getAgentSkills(id),
      getAgentPermissions(id),
      getAgentMcpServers(id),
    ]);

    const snapshot = await createSnapshot(
      id, 'manual', session?.username ?? 'system', label,
      skills.map(skillToSnapshotSkill),
      perms?.allowedTools ?? [],
      perms?.deniedTools ?? [],
      mcps.map(m => m.id),
      agent?.claudeMd ?? '',
    );

    return NextResponse.json(snapshot, { status: 201 });
  } catch (err) {
    return apiError('agents/[id]/snapshots', err);
  }
}
