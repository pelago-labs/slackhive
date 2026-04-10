/**
 * @fileoverview REST API routes for an agent's CLAUDE.md instruction file.
 *
 * CLAUDE.md is the agent's main identity/instruction file, stored as
 * agents.claude_md in the database. It is separate from skills — skills
 * are Claude Code slash commands written to .claude/commands/ at runtime.
 *
 * GET /api/agents/[id]/claude-md — Returns the stored CLAUDE.md content
 *                                  with memories appended (read-only view).
 * PUT /api/agents/[id]/claude-md — Updates agents.claude_md directly.
 *
 * @module web/api/agents/[id]/claude-md
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, updateAgentClaudeMd, publishAgentEvent, getAgentSkills, getAgentPermissions, getAgentMcpServers, createSnapshot } from '@/lib/db';
import { guardAgentWrite } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import { skillToSnapshotSkill } from '@/lib/compile';

/**
 * GET /api/agents/[id]/claude-md
 * Returns the agent's CLAUDE.md content with memories appended.
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

  const sections: string[] = [];

  if (agent.claudeMd.trim()) {
    sections.push(agent.claudeMd.trim());
  } else {
    // Fallback: minimal identity block if claude_md not yet set
    const lines = [`# ${agent.name}`];
    if (agent.persona) lines.push('', agent.persona);
    if (agent.description) lines.push('', agent.description);
    sections.push(lines.join('\n'));
  }

  // Memories are shown separately in the Memory tab — not appended to CLAUDE.md preview.

  return new NextResponse(sections.join('\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * PUT /api/agents/[id]/claude-md
 * Saves the CLAUDE.md content to agents.claude_md.
 * Does NOT touch skills — skills are managed separately via /api/agents/[id]/skills.
 * Body: raw text/plain content.
 *
 * @param {NextRequest} req
 * @param {{ params: Promise<{ id: string }> }} ctx
 * @returns {Promise<NextResponse>} 204 No Content or error.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;
  const agent = await getAgentById(id);
  if (!agent) return new NextResponse('Not found', { status: 404 });

  const content = await req.text();
  if (!content.trim()) return new NextResponse('Empty content', { status: 400 });

  // Snapshot current state before overwriting — only if content actually changed
  if (content.trim() !== agent.claudeMd.trim()) {
    const session = getSessionFromRequest(req);
    const [currentSkills, currentPerms, currentMcps] = await Promise.all([
      getAgentSkills(id),
      getAgentPermissions(id),
      getAgentMcpServers(id),
    ]);
    await createSnapshot(
      id, 'claude-md', session?.username ?? 'system', null,
      currentSkills.map(skillToSnapshotSkill),
      currentPerms?.allowedTools ?? [],
      currentPerms?.deniedTools ?? [],
      currentMcps.map(m => m.id),
      agent.claudeMd,
    ).catch(() => {});
  }

  await updateAgentClaudeMd(id, content);
  await publishAgentEvent({ type: 'reload', agentId: id });
  return new NextResponse(null, { status: 204 });
}
