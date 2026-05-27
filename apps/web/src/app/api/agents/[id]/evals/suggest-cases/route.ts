/**
 * @fileoverview POST /api/agents/[id]/evals/suggest-cases
 *
 * Asks the runner for N drafts, then persists each as a 'proposed'
 * eval case so the work survives navigation/disconnect. Returns the
 * persisted rows; the FormView uses the first row's id to track which
 * proposed case to promote on Create.
 *
 * Uses the Coach model setting (same creative model as the Coach feature).
 *
 * @module web/api/agents/[id]/evals/suggest-cases
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardAgentWrite } from '@/lib/api-guard';
import { getSessionFromRequest } from '@/lib/auth';
import {
  createEvalCase,
  getAgentById,
  getAgentMcpServers,
  getAgentSkills,
  getAgentWikiFolders,
  getEvalCases,
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

    const session = getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { count?: number };
    const count = Math.min(Math.max(body.count ?? DEFAULT_COUNT, 1), MAX_COUNT);

    const [skills, mcps, wikiFolders, existingCases] = await Promise.all([
      getAgentSkills(id),
      getAgentMcpServers(id),
      getAgentWikiFolders(id),
      getEvalCases(id),
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
      existingQuestions: existingCases.map((c) => c.question),
      count,
      model,
    });

    // Persist each draft as a 'proposed' case so the work survives if
    // the client disconnects mid-fetch. The FormView promotes the first
    // returned case to 'approved' on Create instead of creating a new
    // duplicate.
    const persisted = await Promise.all(
      suggestions.map((s) =>
        createEvalCase(
          id,
          { question: s.question, checks: s.checks, status: 'proposed' },
          session.username,
        ),
      ),
    );

    return NextResponse.json({ suggestions: persisted });
  } catch (err) {
    return apiError('agents/[id]/evals/suggest-cases:POST', err);
  }
}
