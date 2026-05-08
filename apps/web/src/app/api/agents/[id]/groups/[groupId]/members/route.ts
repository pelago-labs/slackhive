import { NextRequest, NextResponse } from 'next/server';
import { guardAdmin } from '@/lib/api-guard';
import { listGroupMembers, setGroupMembers } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; groupId: string }> }
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { groupId } = await params;
  const members = await listGroupMembers(groupId);
  return NextResponse.json({ members });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; groupId: string }> }
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;
  const { groupId } = await params;
  const body = await req.json().catch(() => ({}));
  const userIds = Array.isArray(body.userIds) ? body.userIds.filter((u: unknown) => typeof u === 'string') : null;
  if (userIds === null) return NextResponse.json({ error: 'userIds (string[]) required' }, { status: 400 });
  await setGroupMembers(groupId, userIds);
  const members = await listGroupMembers(groupId);
  return NextResponse.json({ members });
}
