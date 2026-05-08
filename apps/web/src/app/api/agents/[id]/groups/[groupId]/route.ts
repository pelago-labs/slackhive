import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { getAgentGroup, updateAgentGroup, deleteAgentGroup, listGroupMembers, parseAgentGroupsConflict } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; groupId: string }> }
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { groupId } = await params;
  const group = await getAgentGroup(groupId);
  if (!group) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const members = await listGroupMembers(groupId);
  return NextResponse.json({ group, members });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; groupId: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { groupId } = await params;
  const body = await req.json().catch(() => ({}));
  const patch: { name?: string; description?: string | null; instructions?: string; priority?: number; verbose?: boolean } = {};
  if (typeof body.name === 'string')        patch.name = body.name.trim();
  if ('description' in body)                patch.description = body.description ?? null;
  if (typeof body.instructions === 'string') patch.instructions = body.instructions;
  if (typeof body.priority === 'number') {
    if (!Number.isFinite(body.priority) || !Number.isInteger(body.priority) || body.priority < 0 || body.priority > 1_000_000) {
      return NextResponse.json({ error: 'priority must be a non-negative integer ≤ 1,000,000', field: 'priority' }, { status: 400 });
    }
    patch.priority = body.priority;
  }
  if (typeof body.verbose === 'boolean')    patch.verbose = body.verbose;
  try {
    const group = await updateAgentGroup(groupId, patch);
    if (!group) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ group });
  } catch (e) {
    const conflict = parseAgentGroupsConflict(e);
    if (conflict) return NextResponse.json({ error: conflict.message, field: conflict.field }, { status: 409 });
    throw e;
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; groupId: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { groupId } = await params;
  await deleteAgentGroup(groupId);
  return new NextResponse(null, { status: 204 });
}
