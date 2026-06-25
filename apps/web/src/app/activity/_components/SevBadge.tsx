/**
 * @fileoverview Shared severity palette + badge for the activity/observability
 * surfaces, so the colors and pill markup live in one place (was duplicated across
 * the trace page and the observability Sensitive tab).
 *
 * @module web/app/activity/_components/SevBadge
 */
import React from 'react';
import type { Severity } from '@slackhive/shared';

export const SEV_COLOR: Record<Severity, string> = {
  critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#0891b2',
};

/** Uppercase severity pill tinted by {@link SEV_COLOR}. */
export function SevBadge({ s }: { s: Severity }): React.JSX.Element {
  return (
    <span
      className="text-2xs font-bold uppercase tracking-[0.04em] px-1.5 py-0.5 rounded-md"
      style={{ background: `${SEV_COLOR[s]}1a`, color: SEV_COLOR[s] }}
    >
      {s}
    </span>
  );
}
