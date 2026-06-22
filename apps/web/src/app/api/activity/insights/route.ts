/**
 * @fileoverview Composed endpoint for the LLMOps insights page. One request returns
 * the rollup + by-agent + power-users + sensitive feed + tools + sessions for a scope
 * (all agents | one agent | one session), resolving auth/RBAC and the time window once.
 *
 * Token-visibility policy: tokens/cost are visible to editor+ (editors are always
 * scoped to their own agents, so the figures are their own usage). Only the org-wide
 * power-users leaderboard stays superadmin-only.
 *
 * @module web/api/activity/insights
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getInsightsRollup, getSessionTrace, getSessionSummaries, getSensitiveEvents, getSensitiveFlows, getToolStats,
  getTokensByAgent, getTopUsers,
  type UserActivitySummary,
} from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowBounds } from '@/lib/activity-window';

export const dynamic = 'force-dynamic';

type Scope = 'all' | 'agent' | 'session';

/**
 * GET /api/activity/insights
 *   ?scope=all|agent|session &agent= &session= &window= &from= &to= &sensitive= &errors=
 * Returns one coherent snapshot for the requested scope.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    if (session.role === 'viewer') return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });

    const accessibleAgentIds = await listAccessibleAgentIds(session.username, session.role);
    // Tokens/cost are visible to anyone who reaches here (editor+): editors are
    // always scoped to their OWN agents, admins are trusted. Only the org-wide
    // power-users leaderboard stays superadmin-only.
    const showPowerUsers = session.role === 'superadmin';
    const { searchParams } = new URL(req.url);
    const { since, until } = windowBounds(searchParams.get('window'), searchParams.get('from'), searchParams.get('to'));
    const agentId = searchParams.get('agent') ?? undefined;
    const sessionId = searchParams.get('session') ?? undefined;
    const scope: Scope = sessionId ? 'session' : agentId ? 'agent' : 'all';

    const canSeeAgent = (id: string | undefined): boolean =>
      !!id && (accessibleAgentIds === null || accessibleAgentIds.includes(id));

    // ── Single-session scope: rollup + flows for that thread; the page links to
    //    /activity/[taskId] (it already has the sessionId) for the full trace. ──
    if (scope === 'session') {
      // getSessionTrace scopes turns/spans to the caller's accessible agents, so an
      // inaccessible (or unknown) session yields no turns → 404.
      const trace = await getSessionTrace(sessionId!, accessibleAgentIds ?? undefined);
      if (!trace || trace.turns.length === 0) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }
      return NextResponse.json({
        scope, session: sessionId,
        rollup: trace.rollup,
        flows: trace.flows,
        models: trace.rollup?.models ?? [],
        agentIds: [...new Set(trace.turns.map(t => t.agentId))],
      });
    }

    // ── Agent scope: reject an agent the caller can't access. ──
    if (scope === 'agent' && !canSeeAgent(agentId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const acc = accessibleAgentIds ?? undefined;
    const filter = { agentId: scope === 'agent' ? agentId : undefined, since, until, accessibleAgentIds: acc };

    const [rollup, byAgent, powerUsers, events, flows, tools, sessionsRaw] = await Promise.all([
      getInsightsRollup(filter),
      getTokensByAgent(filter),
      showPowerUsers ? getTopUsers(filter, 10) : Promise.resolve([] as UserActivitySummary[]),
      getSensitiveEvents({ ...filter, limit: 200 }),
      getSensitiveFlows({ ...filter, limit: 100 }),
      getToolStats(filter),
      getSessionSummaries(filter, 100),
    ]);

    return NextResponse.json({
      scope, agent: agentId ?? null,
      rollup, byAgent,
      // Org-wide power-users leaderboard is superadmin-only.
      powerUsers: showPowerUsers ? powerUsers : null,
      events, flows, tools, sessions: sessionsRaw,
    });
  } catch (err) {
    return apiError('activity-insights', err);
  }
}
