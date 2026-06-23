/**
 * @fileoverview Canonical relative-time formatter for the web UI. One source of
 * truth so the activity board, trace page, observability tables, home page and
 * evals all render elapsed time the same way ("3h ago"), instead of the drifted
 * copies ("3h" / "3h ago" / "3 hr ago") that existed per-surface.
 *
 * Accepts ISO strings, epoch milliseconds, a Date, or a SQLite
 * "YYYY-MM-DD HH:MM:SS" timestamp (which is UTC and must be normalized so it
 * isn't parsed as local time). Returns '' for missing/invalid input.
 *
 * @module web/lib/time
 */

/** Normalize any supported input to epoch ms, or null if missing/unparseable. */
function toMillis(input: Date | string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (input instanceof Date) { const t = input.getTime(); return Number.isNaN(t) ? null : t; }
  const s = input.trim();
  if (!s) return null;
  // SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" with no zone — it's UTC.
  // Turn it into an ISO-UTC string so Date.parse doesn't read it as local time.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : t;
}

/** Compact relative time, e.g. "just now", "5s ago", "3m ago", "2h ago", "4d ago",
 *  "3mo ago", "2y ago". */
export function relativeTime(input: Date | string | number | null | undefined): string {
  const ts = toMillis(input);
  if (ts == null) return '';
  const s = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (s < 30) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24); if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
