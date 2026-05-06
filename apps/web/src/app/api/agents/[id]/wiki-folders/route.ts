import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { getAgentWikiFolders, getWikiFolder, assignWikiFolder, unassignWikiFolder } from '@/lib/db';
import { guardAgentWrite, guardAuth } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const deny = guardAuth(req);
  if (deny) return deny;
  try {
    const { id } = await params;
    const folders = await getAgentWikiFolders(id);
    return NextResponse.json(folders);
  } catch (err) {
    return apiError('agents/[id]/wiki-folders', err);
  }
}

/** PUT — replace all wiki folder assignments (same pattern as MCPs) */
export async function PUT(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const agentDenied = await guardAgentWrite(req, (await params).id);
  if (agentDenied) return agentDenied;

  try {
    const { id: agentId } = await params;
    const { folderIds } = (await req.json()) as { folderIds: string[] };
    const normalizedIds: string[] = folderIds ?? [];

    const isAdmin = session.role === 'admin' || session.role === 'superadmin';

    if (!isAdmin && normalizedIds.length) {
      const folders = await Promise.all(normalizedIds.map(fid => getWikiFolder(fid)));
      const unauthorized = folders.find(f => f && f.createdBy !== session.username);
      if (unauthorized) {
        return NextResponse.json(
          { error: `Only the folder creator or an admin can assign "${unauthorized.name}"` },
          { status: 403 },
        );
      }
    }

    const current = await getAgentWikiFolders(agentId);
    const currentIds = new Set(current.map(f => f.id));
    const newIds = new Set(normalizedIds);

    // Unassign removed
    for (const f of current) {
      if (!newIds.has(f.id)) {
        if (!isAdmin && f.createdBy !== session.username) {
          return NextResponse.json(
            { error: `Only the folder creator or an admin can remove "${f.name}"` },
            { status: 403 },
          );
        }
        await unassignWikiFolder(agentId, f.id);
      }
    }

    // Assign added
    for (const fid of normalizedIds) {
      if (!currentIds.has(fid)) {
        await assignWikiFolder(agentId, fid);
      }
    }

    return NextResponse.json(await getAgentWikiFolders(agentId));
  } catch (err) {
    return apiError('agents/[id]/wiki-folders', err);
  }
}

