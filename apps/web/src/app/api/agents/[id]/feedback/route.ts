/**
 * @fileoverview Per-agent feedback report for the Overview score + Settings
 * report card. Agent-scoped (any authenticated user via guardAuth), mirroring
 * /api/agents/[id]/usage.
 *
 * GET → { up, down, total, scorePercent, recentNotes }  (all-time, no window
 * filter — feedback volume is low; the report card shows the lifetime score).
 *
 * @module web/api/agents/[id]/feedback
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFeedbackReport } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { guardAuth } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAuth(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const sp = req.nextUrl.searchParams;
    const notesLimit = sp.get('notesLimit') ? parseInt(sp.get('notesLimit')!, 10) : undefined;
    const notesOffset = sp.get('notesOffset') ? parseInt(sp.get('notesOffset')!, 10) : undefined;
    const report = await getFeedbackReport(id, { notesLimit, notesOffset });
    return NextResponse.json(report);
  } catch (err) {
    return apiError('agents/[id]/feedback', err);
  }
}
