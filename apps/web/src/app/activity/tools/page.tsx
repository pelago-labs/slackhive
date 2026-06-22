/**
 * @fileoverview Redirect stub — the tools analytics view was consolidated into the
 * top-level /observability page (Tools tab). Forwards old /activity/tools links
 * there, preserving query params (agent/window/from/to) and selecting the tab.
 *
 * @module web/app/activity/tools
 */

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function ToolsRedirect(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
): Promise<never> {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') qs.set(k, v);
    else if (Array.isArray(v) && v[0] != null) qs.set(k, v[0]);
  }
  qs.set('tab', 'tools');
  redirect(`/observability?${qs.toString()}`);
}
