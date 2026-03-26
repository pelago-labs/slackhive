/**
 * @fileoverview REST API route for agent collection operations.
 *
 * GET  /api/agents — List all agents
 * POST /api/agents — Create a new agent
 *
 * @module web/api/agents
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAllAgents,
  createAgent,
  setAgentMcps,
  upsertSkill,
  upsertPermissions,
  publishAgentEvent,
} from '@/lib/db';
import type { CreateAgentRequest } from '@slackhive/shared';
import { SKILL_TEMPLATES } from '@/lib/skill-templates';
import { regenerateBossRegistry } from '@/lib/boss-registry';
import { guardAdmin } from '@/lib/api-guard';

/**
 * GET /api/agents
 * Returns all registered agents ordered boss-first.
 *
 * @returns {Promise<NextResponse>} JSON array of Agent objects.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const agents = await getAllAgents();
    return NextResponse.json(agents);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/agents
 * Creates a new agent with its initial configuration.
 * Also bootstraps skills from a template and assigns MCPs.
 * Publishes a start event so the runner picks it up immediately.
 *
 * @param {NextRequest} request - Request body matching CreateAgentRequest.
 * @returns {Promise<NextResponse>} The created Agent (201), or error.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(request);
  if (denied) return denied;
  try {
    const body = (await request.json()) as CreateAgentRequest;

    // Validate required fields
    if (!body.slug || !body.name || !body.slackBotToken || !body.slackAppToken || !body.slackSigningSecret) {
      return NextResponse.json(
        { error: 'slug, name, slackBotToken, slackAppToken, slackSigningSecret are required' },
        { status: 400 }
      );
    }

    // Create the agent record
    const agent = await createAgent(body);

    // Assign MCPs if provided
    if (body.mcpServerIds?.length) {
      await setAgentMcps(agent.id, body.mcpServerIds);
    }

    // Bootstrap skills from template
    const template = body.skillTemplate ?? 'blank';
    const skills = SKILL_TEMPLATES[template](agent);
    for (const skill of skills) {
      await upsertSkill(agent.id, skill.category, skill.filename, skill.content, skill.sortOrder);
    }

    // Create default permissions (Read + selected MCP tools)
    const allowedTools = ['Read'];
    await upsertPermissions(agent.id, allowedTools, []);

    // Signal the runner to start this agent
    await publishAgentEvent({ type: 'start', agentId: agent.id });

    // Regenerate boss registry now that team has a new member
    await regenerateBossRegistry().catch(() => {});

    return NextResponse.json(agent, { status: 201 });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('unique')) {
      return NextResponse.json({ error: 'An agent with this slug already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
