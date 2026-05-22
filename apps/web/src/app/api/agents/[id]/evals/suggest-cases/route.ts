/**
 * @fileoverview POST /api/agents/[id]/evals/suggest-cases
 *
 * LLM-generates N proposed test cases for the agent and persists them
 * with status='proposed'. The user reviews them through the existing
 * Manage cases drawer.
 *
 * Uses the Coach model setting (creative work, same as Coach itself).
 *
 * @module web/api/agents/[id]/evals/suggest-cases
 */

/**
 * @fileoverview POST /api/agents/[id]/evals/suggest-cases
 *
 * Returns LLM-generated case drafts (question + checks) — does NOT save
 * anything. The UI uses the draft to populate the "New test case" form;
 * the user reviews/edits and clicks Create case to commit via the regular
 * POST /cases endpoint.
 *
 * Uses the Coach model setting.
 *
 * @module web/api/agents/[id]/evals/suggest-cases
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAgentWrite } from '@/lib/api-guard';
import {
  getAgentById,
  getAgentMcpServers,
  getAgentSkills,
  getAgentWikiFolders,
  getSetting,
  getWikiSources,
} from '@/lib/db';
import { suggestCases } from '@/lib/evals/suggest-cases';
import {
  COACH_MODEL_SETTING_KEY,
  DEFAULT_COACH_MODEL,
} from '@slackhive/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

const DEFAULT_COUNT = 1;
const MAX_COUNT = 10;

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const denied = await guardAgentWrite(req, id);
    if (denied) return denied;

    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { count?: number };
    const count = Math.min(Math.max(body.count ?? DEFAULT_COUNT, 1), MAX_COUNT);

    const [skills, mcps, wikiFolders] = await Promise.all([
      getAgentSkills(id),
      getAgentMcpServers(id),
      getAgentWikiFolders(id),
    ]);
    const wikiSources = (
      await Promise.all(wikiFolders.map((f) => getWikiSources(f.id)))
    ).flat();

    const model = (await getSetting(COACH_MODEL_SETTING_KEY)) ?? DEFAULT_COACH_MODEL;

    const suggestions = await suggestCases({
      agent: {
        name: agent.name,
        description: agent.description,
        persona: agent.persona,
        claudeMd: agent.claudeMd,
      },
      skills: skills.map((s) => ({
        category: s.category,
        filename: s.filename,
        content: s.content,
      })),
      wikiSources: wikiSources.map((w) => ({
        name: w.name,
        content: w.content,
      })),
      mcps: mcps.map((m) => ({ name: m.name, description: m.description })),
      count,
      model,
    });

    return NextResponse.json({ suggestions });
  } catch (err) {
    return apiError('agents/[id]/evals/suggest-cases:POST', err);
  }
}
