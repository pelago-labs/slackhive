/**
 * @fileoverview Token count formatting helper — `1.2M` / `340K` / raw digits.
 *
 * @module web/app/activity/_components/formatTokens
 */

/** Render a token count at human scale: `1.2M`, `340K`, or raw digits. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}
