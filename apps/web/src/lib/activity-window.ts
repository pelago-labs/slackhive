/**
 * @fileoverview Shared time-window helper used by every `/api/activity/*` route.
 *
 * Maps UI window strings (`1h`, `5h`, `24h`, `7d`, `30d`) to SQLite-stored
 * ISO floor timestamps for `WHERE started_at >= $floor` clauses. Centralized
 * here so adding a new window is a one-line change instead of three.
 *
 * @module web/lib/activity-window
 */

export const VALID_WINDOWS = new Set(['1h', '5h', '24h', '7d', '30d', '90d']);

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
    w === '90d' ? 90 * 24 * 60 * 60 * 1000 :
                  30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Turn a UI date/time value into a stored `YYYY-MM-DD HH:MM:SS` (UTC) bound.
 * Accepts a date (`YYYY-MM-DD`) or a `datetime-local` value
 * (`YYYY-MM-DDTHH:MM[:SS]`), both interpreted in the runtime's local timezone
 * (the standalone host's), then normalized to UTC to match stored timestamps.
 */
function toBound(d: string | null, endOfDayIfDateOnly: boolean): string | undefined {
  if (!d) return undefined;
  const raw = d.length <= 10 ? `${d}T${endOfDayIfDateOnly ? '23:59:59' : '00:00:00'}` : d;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Resolve the time filter from the UI: a preset `window`, or an explicit
 * `from`/`to` range when `window === 'custom'`. Returns `{ since, until }`
 * for an ActivityFilter (`until` only set for custom ranges).
 */
export function windowBounds(
  window: string | null,
  from: string | null,
  to: string | null,
): { since?: string; until?: string } {
  // An explicit from/to range takes precedence over any preset window — the
  // client may send the dates without a `window=custom` param.
  // Tolerate a reversed range (e.g. a hand-crafted URL) by swapping the RAW inputs
  // before deriving bounds, so the start keeps 00:00:00 and the end 23:59:59 (a
  // post-toBound swap would instead lop ~a day off each end).
  if (from && to && from > to) { const t = from; from = to; to = t; }
  const since = toBound(from, false);
  const until = toBound(to, true);
  if (since || until) return { since, until };
  return { since: windowFloor(window) };
}
