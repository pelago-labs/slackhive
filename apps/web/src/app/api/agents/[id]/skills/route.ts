/**
 * @fileoverview REST API routes for agent skills.
 *
 * GET  /api/agents/[id]/skills — List all skills for an agent
 * POST /api/agents/[id]/skills — Create or update a skill, then trigger reload
 *
 * @module web/api/agents/[id]/skills
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, getAgentSkills, upsertSkill, publishAgentEvent, getAgentPermissions, getAgentMcpServers, createSnapshot } from '@/lib/db';
import type { UpsertSkillRequest } from '@slackhive/shared';
import { guardAdmin } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { compileSkillsOnly, skillToSnapshotSkill } from '@/lib/compile';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/agents/[id]/skills
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} JSON array of Skill objects.
 */
export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const skills = await getAgentSkills(id);
    return NextResponse.json(skills);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/agents/[id]/skills
 * Creates or updates a skill file, then publishes a reload event.
 *
 * @param {NextRequest} req - Body: { category, filename, content, sortOrder? }
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} The upserted Skill or error.
 */
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = (await req.json()) as UpsertSkillRequest & { category: string; filename: string };
    if (!body.category || !body.filename || body.content === undefined) {
      return NextResponse.json({ error: 'category, filename, content are required' }, { status: 400 });
    }

    // Snapshot current state before mutation
    const session = getSessionFromRequest(req);
    const [agent, currentSkills, perms, mcps] = await Promise.all([
      getAgentById(id),
      getAgentSkills(id),
      getAgentPermissions(id),
      getAgentMcpServers(id),
    ]);
    await createSnapshot(
      id, 'skills', session?.username ?? 'system', null,
      currentSkills.map(skillToSnapshotSkill),
      perms?.allowedTools ?? [],
      perms?.deniedTools ?? [],
      mcps.map(m => m.id),
      compileSkillsOnly(currentSkills, agent ?? undefined),
    ).catch(() => {});

    const skill = await upsertSkill(id, body.category, body.filename, body.content, body.sortOrder ?? 0);
    await publishAgentEvent({ type: 'reload', agentId: id });
    return NextResponse.json(skill, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
