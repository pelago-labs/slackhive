import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { listAgentGroups, createAgentGroup } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const groups = await listAgentGroups(id);
  return NextResponse.json({ groups });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const name = (body.name ?? '').toString().trim();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  try {
    const group = await createAgentGroup({
      agentId: id,
      name,
      description: body.description ?? null,
      instructions: body.instructions ?? '',
      priority: typeof body.priority === 'number' ? body.priority : 100,
      verbose: !!body.verbose,
    });
    return NextResponse.json({ group }, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/UNIQUE constraint failed: agent_groups\.agent_id, agent_groups\.priority/i.test(msg)) {
      return NextResponse.json({ error: 'Another audience already uses that priority. Pick a different number.', field: 'priority' }, { status: 409 });
    }
    if (/UNIQUE constraint failed: agent_groups\.agent_id, agent_groups\.name/i.test(msg)) {
      return NextResponse.json({ error: 'Another audience on this agent already has that name.', field: 'name' }, { status: 409 });
    }
    throw e;
  }
}
