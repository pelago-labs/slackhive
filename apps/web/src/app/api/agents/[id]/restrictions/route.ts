/**
 * @fileoverview REST API routes for per-agent channel restrictions.
 *
 * GET /api/agents/[id]/restrictions — Get current restrictions
 * PUT /api/agents/[id]/restrictions — Replace restrictions, then trigger reload
 *
 * @module web/api/agents/[id]/restrictions
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAgentById,
  getAgentSkills,
  getAgentPermissions,
  getAgentMcpServers,
  getAgentRestrictions,
  upsertRestrictions,
  publishAgentEvent,
  createSnapshot,
} from '@/lib/db';
import type { UpdateRestrictionsRequest } from '@slackhive/shared';
import { guardAgentWrite } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { skillToSnapshotSkill } from '@/lib/compile';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/agents/[id]/restrictions
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} Restriction object or empty default.
 */
export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const restrictions = await getAgentRestrictions(id);
    return NextResponse.json(restrictions ?? { allowedChannels: [] });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * PUT /api/agents/[id]/restrictions
 * Replaces channel restrictions for an agent.
 *
 * @param {NextRequest} req - Body: { allowedChannels: string[] }
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} 200 ok or error.
 */
export async function PUT(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;
    const body = (await req.json()) as UpdateRestrictionsRequest;

    // Snapshot before mutation
    const session = getSessionFromRequest(req);
    const [agent, currentSkills, perms, mcps, currentRestrictions] = await Promise.all([
      getAgentById(id),
      getAgentSkills(id),
      getAgentPermissions(id),
      getAgentMcpServers(id),
      getAgentRestrictions(id),
    ]);
    await createSnapshot(
      id, 'restrictions', session?.username ?? 'system', null,
      currentSkills.map(skillToSnapshotSkill),
      perms?.allowedTools ?? [],
      perms?.deniedTools ?? [],
      mcps.map(m => m.id),
      agent?.claudeMd ?? '',
      currentRestrictions?.allowedChannels ?? [],
    ).catch(() => {});

    await upsertRestrictions(id, body.allowedChannels ?? []);
    await publishAgentEvent({ type: 'reload', agentId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
