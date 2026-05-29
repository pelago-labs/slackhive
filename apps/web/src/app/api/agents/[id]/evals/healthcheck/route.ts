/**
 * @fileoverview GET /api/agents/[id]/evals/healthcheck
 *
 * Runs Tier 1 static healthcheck against an agent's current DB state.
 * Returns `{ summary, issues }` consumed by the Evals tab UI.
 *
 * No mutation — just fetches the agent + related rows and feeds them
 * into `runHealthcheck()`. Re-running shows the agent's current state.
 *
 * @module web/api/agents/[id]/evals/healthcheck
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAuth } from '@/lib/api-guard';
import {
  getAgentById,
  getAgentMcpServers,
  getAgentSkills,
  getAgentWikiFolders,
  getWikiSources,
} from '@/lib/db';
import { runHealthcheck } from '@/lib/evals/run-healthcheck';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const denied = guardAuth(req);
    if (denied) return denied;

    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const [skills, mcps, wikiFolders] = await Promise.all([
      getAgentSkills(id),
      getAgentMcpServers(id),
      getAgentWikiFolders(id),
    ]);

    const wikiSources = (
      await Promise.all(wikiFolders.map((f) => getWikiSources(f.id)))
    ).flat();

    const result = runHealthcheck(agent, skills, mcps, wikiSources);
    return NextResponse.json(result);
  } catch (err) {
    return apiError('agents/[id]/evals/healthcheck', err);
  }
}
