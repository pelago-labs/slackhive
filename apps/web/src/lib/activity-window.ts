/**
 * @fileoverview Shared time-window helper used by every `/api/activity/*` route.
 *
 * Maps UI window strings (`1h`, `5h`, `24h`, `7d`, `30d`) to SQLite-stored
 * ISO floor timestamps for `WHERE started_at >= $floor` clauses. Centralized
 * here so adding a new window is a one-line change instead of three.
 *
 * @module web/lib/activity-window
 */

export const VALID_WINDOWS = new Set(['1h', '5h', '24h', '7d', '30d']);

/**
 * Translate a UI window string to an ISO timestamp floor. SQLite stores
 * timestamps as `YYYY-MM-DD HH:MM:SS` via `datetime('now')`, and string
 * comparison against ISO-lexicographic values sorts correctly.
 *
 * Returns `undefined` for missing/invalid windows so callers can pass the
 * result straight into an `ActivityFilter`.
 */
export function windowFloor(w: string | null): string | undefined {
  if (!w || !VALID_WINDOWS.has(w)) return undefined;
  const ms =
    w === '1h'  ? 60 * 60 * 1000 :
    w === '5h'  ? 5 * 60 * 60 * 1000 :
    w === '24h' ? 24 * 60 * 60 * 1000 :
    w === '7d'  ? 7 * 24 * 60 * 60 * 1000 :
                  30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}
