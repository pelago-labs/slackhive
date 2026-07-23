/**
 * @fileoverview POST /api/agents/[id]/slack/provision — auto-creates the agent's
 * Slack app via the manifest API (admin-only). Returns the install URL for the
 * next onboarding step. 409 when an app is already provisioned for the agent.
 *
 * @module web/api/agents/[id]/slack/provision
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-error';
import { guardUserAdmin } from '@/lib/api-guard';
import { getAgentById } from '@/lib/db';
import { getProvisioner, ProvisionError } from '@/lib/platforms';
import { originFromRequest } from '@/lib/request-origin';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

const ERROR_STATUS: Record<ProvisionError['code'], number> = {
  not_configured: 501,
  invalid_config_token: 502,
  platform_rejected: 422,
};

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const denied = guardUserAdmin(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (agent.slackAppId) {
      return NextResponse.json({ error: 'A Slack app is already provisioned for this agent', appId: agent.slackAppId }, { status: 409 });
    }

    const provisioner = getProvisioner('slack');
    if (!provisioner) return NextResponse.json({ error: 'No provisioner for slack' }, { status: 500 });

    const result = await provisioner.provision(agent, originFromRequest(req));
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ProvisionError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: ERROR_STATUS[err.code] });
    }
    return apiError('agents/[id]/slack/provision', err);
  }
}
