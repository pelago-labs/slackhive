/**
 * @fileoverview GET /api/agents/[id]/manifest
 * Returns a generated Slack app manifest JSON for the agent onboarding wizard.
 * Paste the output into api.slack.com/apps → Create from Manifest.
 *
 * @module web/api/agents/[id]/manifest
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentById } from '@/lib/db';
import { generateSlackManifest } from '@/lib/slack-manifest';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/agents/[id]/manifest
 *
 * @param {NextRequest} _req
 * @param {RouteParams} ctx
 * @returns {Promise<NextResponse>} SlackAppManifest JSON or error.
 */
export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const manifest = generateSlackManifest({ name: agent.name, description: agent.description, isBoss: agent.isBoss });
    return NextResponse.json(manifest);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
