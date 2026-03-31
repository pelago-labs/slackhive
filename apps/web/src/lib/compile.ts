/**
 * @fileoverview Skills compilation utilities.
 *
 * Extracts the skills-only CLAUDE.md compilation logic so it can be
 * shared between the claude-md GET route and snapshot creation.
 *
 * @module web/lib/compile
 */

import type { Skill } from '@slackhive/shared';
import type { SnapshotSkill } from '@slackhive/shared';

/**
 * Compiles a skills array into the skills-only portion of CLAUDE.md.
 * Mirrors the compilation logic in GET /api/agents/[id]/claude-md,
 * but without the memories section.
 *
 * @param {Skill[]} skills - Skills sorted by sortOrder (or unsorted — sorted internally).
 * @param {{ name: string; description?: string; persona?: string }} [fallback] - Agent
 *   identity used when no skills exist.
 * @returns {string} Compiled markdown text.
 */
export function compileSkillsOnly(
  skills: Skill[],
  fallback?: { name: string; description?: string; persona?: string },
): string {
  if (skills.length === 0) {
    if (!fallback) return '';
    return `# ${fallback.name}\n\n${fallback.description ?? ''}\n\nPersona: ${fallback.persona ?? 'A helpful assistant.'}`;
  }
  return [...skills]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(s => s.content.trim().replace(/^<!--\s*skill:.*?-->\s*\n?/, '').trim())
    .join('\n\n');
}

/**
 * Maps a Skill DB record to the minimal SnapshotSkill shape for storage
 * in agent_snapshots.skills_json.
 *
 * @param {Skill} s - Full skill record from the database.
 * @returns {SnapshotSkill}
 */
export function skillToSnapshotSkill(s: Skill): SnapshotSkill {
  return {
    category: s.category,
    filename: s.filename,
    content: s.content,
    sort_order: s.sortOrder,
  };
}
