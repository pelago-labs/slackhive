import { NextRequest, NextResponse } from 'next/server';
import { guardAgentWrite } from '@/lib/api-guard';
import { getAgentById } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Polishes audience-group instructions via Claude. Forwards to the runner's
 * internal `/polish-audience-instructions` endpoint, which owns the SDK auth.
 *
 * Body: { audienceName, audienceDescription?, verbose?, draft }
 * Returns: { text }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const denied = await guardAgentWrite(req, id);
  if (denied) return denied;
  const agent = await getAgentById(id);
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const audienceName = (body.audienceName ?? '').toString().trim();
  if (!audienceName) {
    return NextResponse.json({ error: 'audienceName required' }, { status: 400 });
  }

  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/polish-audience-instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audienceName,
        audienceDescription: body.audienceDescription ?? null,
        agentName: agent.name,
        agentDescription: agent.description ?? null,
        verbose: !!body.verbose,
        draft: typeof body.draft === 'string' ? body.draft : '',
      }),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return new NextResponse(text || 'polish failed', { status: upstream.status || 502 });
    }
    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return NextResponse.json({ error: 'runner unreachable', detail: (err as Error).message }, { status: 502 });
  }
}
