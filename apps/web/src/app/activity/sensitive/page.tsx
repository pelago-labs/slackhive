/**
 * @fileoverview Redirect stub — the sensitive-access view was consolidated into the
 * top-level /observability page (Sensitive tab). Forwards old /activity/sensitive
 * links there, preserving query params (agent/window/from/to) and selecting the tab.
 *
 * @module web/app/activity/sensitive
 */

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function SensitiveRedirect(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
): Promise<never> {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') qs.set(k, v);
    else if (Array.isArray(v) && v[0] != null) qs.set(k, v[0]);
  }
  qs.set('tab', 'sensitive');
  redirect(`/observability?${qs.toString()}`);
}
