import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, getAgentSkills, getAgentMemories, upsertSkill, deleteSkillsByAgent } from '@/lib/db';

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

  if (skills.length > 0) {
    const skillParts = [...skills]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(s => s.content.trim().replace(/^<!--\s*skill:.*?-->\s*\n?/, '').trim());
    sections.push(skillParts.join('\n\n'));
  } else {
    sections.push(`# ${agent.name}\n\n${agent.description ?? ''}\n\nPersona: ${agent.persona ?? 'A helpful assistant.'}`);
  }

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
  const { id } = await params;
  const agent = await getAgentById(id);
  if (!agent) return new NextResponse('Not found', { status: 404 });

  const content = await req.text();
  if (!content.trim()) return new NextResponse('Empty content', { status: 400 });

  await deleteSkillsByAgent(id);
  await upsertSkill(id, '00-core', 'main.md', content, 0);

  return new NextResponse(null, { status: 204 });
}
