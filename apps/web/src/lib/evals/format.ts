/**
 * @fileoverview Tiny formatting helpers shared across the Evals UI.
 *
 * @module web/lib/evals/format
 */

/**
 * Renders a timestamp as a short relative string ("3 min ago", "2 hr ago").
 *
 * Accepts `Date | string | number` because eval API responses serialize
 * dates as ISO strings — TypeScript types say one thing, JSON over the
 * wire delivers another.
 */
export function relativeTime(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
  return `${Math.floor(diffSec / 86400)} days ago`;
}

/**
 * Renders elapsed time since a start timestamp as `M:SS` (e.g. "0:06",
 * "1:23"). Used by the in-progress segmented bar — finer-grained than
 * `relativeTime`, which only updates in "min ago" steps.
 */
export function elapsedMmSs(startedAt: Date | string | number): string {
  const date = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const sec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
