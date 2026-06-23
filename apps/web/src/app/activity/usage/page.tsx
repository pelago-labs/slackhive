/**
 * @fileoverview Redirect stub — the per-agent token/cost view was consolidated into
 * the top-level /observability page (Tokens & Cost tab). Forwards old /activity/usage
 * links there, preserving query params (agent/window/from/to) and selecting the tab.
 *
 * @module web/app/activity/usage
 */

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function UsageRedirect(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
): Promise<never> {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') qs.set(k, v);
    else if (Array.isArray(v) && v[0] != null) qs.set(k, v[0]);
  }
  qs.set('tab', 'tokens');
  redirect(`/observability?${qs.toString()}`);
}
