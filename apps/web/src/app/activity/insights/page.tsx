/**
 * @fileoverview Redirect stub — the LLMOps view moved to the top-level
 * /observability route. Forwards old /activity/insights links (bookmarks, the
 * former tab) there, preserving query params (tab/agent/session/window/…).
 *
 * @module web/app/activity/insights
 */

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function InsightsRedirect(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
): Promise<never> {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') qs.set(k, v);
    else if (Array.isArray(v) && v[0] != null) qs.set(k, v[0]);
  }
  const s = qs.toString();
  redirect(`/observability${s ? `?${s}` : ''}`);
}
