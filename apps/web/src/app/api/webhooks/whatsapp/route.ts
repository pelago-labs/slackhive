/**
 * @fileoverview WhatsApp Cloud API webhook — receives events from Meta.
 *
 * GET  /api/webhooks/whatsapp — Meta webhook verification handshake.
 * POST /api/webhooks/whatsapp — Incoming WhatsApp messages/events.
 *
 * On POST, the payload is forwarded to the runner's internal server at
 * /whatsapp, which routes each entry to the correct WhatsAppAdapter instance
 * by phoneNumberId.
 *
 * @module web/api/webhooks/whatsapp
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const mode = req.nextUrl.searchParams.get('hub.mode');
  const token = req.nextUrl.searchParams.get('hub.verify_token');
  const challenge = req.nextUrl.searchParams.get('hub.challenge');

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) {
    return NextResponse.json({ error: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN not configured' }, { status: 500 });
  }

  if (mode === 'subscribe' && token === verifyToken) {
    return new Response(challenge ?? '', { status: 200 });
  }

  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

export async function POST(req: NextRequest): Promise<Response> {
  const rawBody = await req.text();

  // Verify Meta's HMAC-SHA256 signature when APP_SECRET is configured
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret) {
    const sig = req.headers.get('x-hub-signature-256') ?? '';
    const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    if (sig !== expected) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }
  }

  let payload: { object?: string; entry?: any[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (payload.object !== 'whatsapp_business_account') {
    return NextResponse.json({ ok: true }); // Ignore non-WhatsApp events
  }

  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';

  // Forward each entry to the runner in parallel (fire-and-forget per entry)
  const entries = payload.entry ?? [];
  await Promise.allSettled(
    entries.map((entry: any) =>
      fetch(`http://127.0.0.1:${port}/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry }),
      }).catch((err: unknown) => {
        console.error('[webhooks/whatsapp] runner unreachable', err);
      }),
    ),
  );

  // Meta requires a 200 response quickly — always acknowledge
  return NextResponse.json({ ok: true });
}
