/**
 * @fileoverview Composed endpoint for the LLMOps insights page. One request returns
 * the rollup + by-agent + power-users + sensitive feed + tools + sessions for a scope
 * (all agents | one agent | one session), resolving auth/RBAC and the time window once.
 *
 * Billing-adjacent fields (tokens/cost/power-users) are stripped server-side for
 * non-superadmins so they never reach the client — matching /api/activity/usage.
 *
 * @module web/api/activity/insights
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getInsightsRollup, getSessionTrace, getSensitiveEvents, getSensitiveFlows, getToolStats,
  getTokensByAgent, getTopUsers, listTasks,
  type InsightsRollup, type AgentTokenUsage, type UserActivitySummary,
} from '@slackhive/shared';
import { apiError } from '@/lib/api-error';
import { getSessionFromRequest } from '@/lib/auth';
import { listAccessibleAgentIds } from '@/lib/db';
import { windowBounds } from '@/lib/activity-window';
import { stripRollupBilling } from '@/lib/activity-redact';

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
    const billing = session.role === 'superadmin';
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
      const rollup = billing ? trace.rollup : stripRollupBilling(trace.rollup);
      return NextResponse.json({
        scope, session: sessionId, billing,
        rollup,
        flows: trace.flows,
        models: rollup?.models ?? [],
        agentIds: [...new Set(trace.turns.map(t => t.agentId))],
      });
    }

    // ── Agent scope: reject an agent the caller can't access. ──
    if (scope === 'agent' && !canSeeAgent(agentId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const acc = accessibleAgentIds ?? undefined;
    const filter = { agentId: scope === 'agent' ? agentId : undefined, since, until, accessibleAgentIds: acc };

    const [rollup, byAgent, powerUsers, events, flows, tools, active, recent, errored] = await Promise.all([
      getInsightsRollup(filter),
      getTokensByAgent(filter),
      billing ? getTopUsers(filter, 10) : Promise.resolve([] as UserActivitySummary[]),
      getSensitiveEvents({ ...filter, limit: 200 }),
      getSensitiveFlows({ ...filter, limit: 100 }),
      getToolStats(filter),
      listTasks('active', filter, 50, null),
      listTasks('recent', filter, 50, null),
      listTasks('errored', filter, 50, null),
    ]);

    // Sessions: merge the three columns, newest first (one flat list for the tab).
    const sessions = [...active.tasks, ...recent.tasks, ...errored.tasks]
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));

    const payload = {
      scope, agent: agentId ?? null, billing,
      rollup: billing ? rollup : stripInsightsBilling(rollup),
      byAgent: billing ? byAgent : byAgent.map(stripAgentTokens),
      powerUsers: billing ? powerUsers : null,
      events, flows,
      tools,
      sessions,
    };
    return NextResponse.json(payload);
  } catch (err) {
    return apiError('activity-insights', err);
  }
}

/** Drop token/cost fields from the insights rollup for non-superadmins. */
function stripInsightsBilling(r: InsightsRollup): InsightsRollup {
  return {
    ...r,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0,
    tokensByDay: [],
    models: r.models.map(m => ({ ...m, tokens: 0 })),
  };
}

/** Zero token columns on a per-agent usage row for non-superadmins. */
function stripAgentTokens(a: AgentTokenUsage): AgentTokenUsage {
  return { ...a, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}
