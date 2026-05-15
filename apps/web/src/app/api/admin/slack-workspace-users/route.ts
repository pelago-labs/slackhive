import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { getSetting, upsertSlackUser } from '@/lib/db';
import { getDb } from '@slackhive/shared';

export const dynamic = 'force-dynamic';

async function fetchSlackUsers(token: string): Promise<Array<{ id: string; name: string; email: string }>> {
  const members: Array<{ id: string; name: string; email: string }> = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) });
    const res = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? 'users.list failed');

    for (const m of data.members ?? []) {
      if (m.is_bot || m.deleted || m.id === 'USLACKBOT') continue;
      const email = m.profile?.email ?? '';
      const name = m.profile?.real_name || m.real_name || m.name || '';
      if (!name) continue;
      members.push({ id: m.id, name, email });
    }

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return members;
}

/** GET — list all Slack workspace users with onboarded status */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireRole(req as unknown as Request, 'admin');

    const token = await getSetting('slack_import_bot_token');
    if (!token) return NextResponse.json({ error: 'No import bot token configured.' }, { status: 400 });

    const slackUsers = await fetchSlackUsers(token);

    const d = getDb();
    const existing = await d.query('SELECT slack_user_id, slack_email FROM users');
    const existingSlackIds = new Set(existing.rows.map(r => r.slack_user_id as string).filter(Boolean));
    // Email-only dedup — fallback to username here previously matched display names
    // against Slack emails (always false), polluting the equivalence class with no benefit.
    const existingEmails = new Set(
      existing.rows
        .map(r => r.slack_email as string | null)
        .filter((e): e is string => !!e && e.includes('@'))
    );

    const members = slackUsers.map(u => ({
      ...u,
      onboarded: existingSlackIds.has(u.id) || (!!u.email && existingEmails.has(u.email)),
    }));

    return NextResponse.json({ members });
  } catch (err) {
    return apiError('admin/slack-workspace-users GET', err);
  }
}

/** POST — onboard selected Slack users as viewers */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    requireRole(req as unknown as Request, 'admin');

    const body = await req.json() as { users: Array<{ id: string; email: string; name: string }> };
    if (!Array.isArray(body.users) || !body.users.length) {
      return NextResponse.json({ error: 'No users provided' }, { status: 400 });
    }

    // Pass real email or null — never the display name. The prior `u.email || u.name`
    // fallback caused 88 of 91 production rows to have the user's display name
    // sitting in the slack_email column, breaking dedup, lookups, and any audit
    // that filters by email domain.
    await Promise.all(body.users.map(u => upsertSlackUser(u.id, u.email || null, u.name)));

    return NextResponse.json({ onboarded: body.users.length });
  } catch (err) {
    return apiError('admin/slack-workspace-users POST', err);
  }
}
