/**
 * @fileoverview Per-agent usage summary for the agent Overview panel.
 *
 * Scoped to a single agent the caller is already viewing, so — unlike the
 * global, billing-wide /api/activity/usage (superadmin only) — this is
 * readable by any authenticated user via guardAuth. Returns three headline
 * numbers: queries in the last 30 days, all-time token usage, and the
 * top ("power") user over the last 7 days.
 *
 * @module web/api/agents/[id]/usage
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTokensByAgent, getTopUsers, type ActivityFilter } from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { guardAuth } from '@/lib/api-guard';
import { windowFloor } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/agents/[id]/usage
 *
 * @returns {Promise<NextResponse>} `{ queries30d, totalTokens, powerUser7d }`.
 */
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardAuth(req);
  if (denied) return denied;
  try {
    const { id } = await params;

    const filter30d: ActivityFilter = { agentId: id, since: windowFloor('30d') };
    const filterAll: ActivityFilter = { agentId: id };
    const filter7d: ActivityFilter = { agentId: id, since: windowFloor('7d') };

    const [tokens30d, tokensAll, topUsers7d] = await Promise.all([
      getTokensByAgent(filter30d),
      getTokensByAgent(filterAll),
      getTopUsers(filter7d, 1),
    ]);

    const row30 = tokens30d.find(r => r.agentId === id);
    const rowAll = tokensAll.find(r => r.agentId === id);
    const totalTokens = rowAll
      ? rowAll.inputTokens + rowAll.outputTokens + rowAll.cacheReadTokens + rowAll.cacheCreationTokens
      : 0;
    const top = topUsers7d[0] ?? null;

    return NextResponse.json({
      queries30d: row30?.turnCount ?? 0,
      totalTokens,
      powerUser7d: top
        ? { handle: top.handle ?? top.userId, taskCount: top.taskCount, turnCount: top.turnCount }
        : null,
    });
  } catch (err) {
    return apiError('agents/[id]/usage', err);
  }
}
