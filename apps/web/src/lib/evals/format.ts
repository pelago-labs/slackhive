/**
 * @fileoverview Tiny formatting helpers shared across the Evals UI.
 *
 * @module web/lib/evals/format
 */

// Relative-time formatting is shared app-wide; re-exported here so existing Evals
// imports keep working while there's a single source of truth (see lib/time).
export { relativeTime } from '@/lib/time';

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
