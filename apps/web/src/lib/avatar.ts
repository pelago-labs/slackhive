/**
 * @fileoverview Deterministic avatar helpers — initials + a stable pastel color
 * hashed from an id. Single source for the agent/user avatars that were
 * previously reimplemented per page (dashboard, activity, agents/[slug]).
 *
 * @module web/lib/avatar
 */

/** Initials from a name, max 2 chars (first + last word, or first two letters). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic pastel color for an id (avatar backgrounds, stacks). */
export function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 52%, 54%)`;
}
