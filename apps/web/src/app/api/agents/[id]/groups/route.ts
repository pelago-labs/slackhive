import { NextRequest, NextResponse } from 'next/server';
import { guardAgentWrite } from '@/lib/api-guard';
import { listAgentGroups, createAgentGroup, parseAgentGroupsConflict } from '@/lib/db';
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
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const name = (body.name ?? '').toString().trim();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  const priority = Number.isFinite(body.priority) ? Number(body.priority) : 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) {
    return NextResponse.json({ error: 'priority must be a non-negative integer ≤ 1,000,000', field: 'priority' }, { status: 400 });
  }
  // Normalise description: any string-ish value, trim, then null if empty.
  let description: string | null = null;
  if (typeof body.description === 'string' && body.description.trim().length > 0) {
    description = body.description;
  }
  try {
    const group = await createAgentGroup({
      agentId: id,
      name,
      description,
      instructions: typeof body.instructions === 'string' ? body.instructions : '',
      priority,
      verbose: !!body.verbose,
    });
    return NextResponse.json({ group }, { status: 201 });
  } catch (e) {
    const conflict = parseAgentGroupsConflict(e);
    if (conflict) return NextResponse.json({ error: conflict.message, field: conflict.field }, { status: 409 });
    throw e;
  }
}
