/**
 * @fileoverview REST API routes for an agent's compiled CLAUDE.md.
 *
 * GET /api/agents/[id]/claude-md — Returns compiled CLAUDE.md (skills + memories).
 * PUT /api/agents/[id]/claude-md — Replaces all skills with a single raw upload.
 *
 * @module web/api/agents/[id]/claude-md
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, getAgentSkills, getAgentMemories, upsertSkill, deleteSkillsByAgent, createSnapshot, getAgentPermissions, getAgentMcpServers } from '@/lib/db';
import { guardAdmin } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { compileSkillsOnly, skillToSnapshotSkill } from '@/lib/compile';

/**
 * GET /api/agents/[id]/claude-md
 * Compiles all agent skills and memories into a single CLAUDE.md document.
 *
 * @param {NextRequest} _req
 * @param {{ params: Promise<{ id: string }> }} ctx
 * @returns {Promise<NextResponse>} Plain-text CLAUDE.md or 404.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = await getAgentById(id);
  if (!agent) return new NextResponse('Not found', { status: 404 });

  const [skills, memories] = await Promise.all([
    getAgentSkills(id),
    getAgentMemories(id),
  ]);

  const sections: string[] = [];
  sections.push(compileSkillsOnly(skills, agent));

  if (memories.length > 0) {
    const order = ['feedback', 'user', 'project', 'reference'];
    const grouped = memories.reduce<Record<string, typeof memories>>((acc, m) => {
      (acc[m.type] ??= []).push(m);
      return acc;
    }, {});
    const memParts = order
      .filter(t => grouped[t]?.length)
      .map(t => `## ${t.charAt(0).toUpperCase() + t.slice(1)} Memories\n\n` +
        grouped[t].map(m => `### ${m.name}\n${m.content}`).join('\n\n'));
    sections.push(`# Agent Memory\n\n${memParts.join('\n\n')}`);
  }

  const content = sections.join('\n\n');
  return new NextResponse(content, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * PUT /api/agents/[id]/claude-md
 * Replaces all agent skills with a single raw CLAUDE.md skill.
 * Body: raw text/plain content.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { id } = await params;
  const agent = await getAgentById(id);
  if (!agent) return new NextResponse('Not found', { status: 404 });

  const content = await req.text();
  if (!content.trim()) return new NextResponse('Empty content', { status: 400 });

  // Snapshot current state before replacing all skills
  const session = getSessionFromRequest(req);
  const [currentSkills, currentPerms, currentMcps] = await Promise.all([
    getAgentSkills(id),
    getAgentPermissions(id),
    getAgentMcpServers(id),
  ]);
  await createSnapshot(
    id, 'skills', session?.username ?? 'system', null,
    currentSkills.map(skillToSnapshotSkill),
    currentPerms?.allowedTools ?? [],
    currentPerms?.deniedTools ?? [],
    currentMcps.map(m => m.id),
    compileSkillsOnly(currentSkills, agent),
  ).catch(() => {});

  await deleteSkillsByAgent(id);
  await upsertSkill(id, '00-core', 'main.md', content, 0);

  return new NextResponse(null, { status: 204 });
}
