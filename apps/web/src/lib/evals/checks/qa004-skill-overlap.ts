/**
 * @fileoverview QA004 — Skill description overlap.
 *
 * Tokenizes each skill's `content` (first non-heading paragraph
 * treated as the description), computes Jaccard similarity on every
 * pair, reports pairs with similarity ≥ 0.7. When two skills look
 * nearly identical, Claude can't reliably pick between them — one
 * gets silently shadowed.
 *
 * Severity: warn (Jaccard has false-positive tail; start conservative).
 *
 * @module web/lib/evals/checks/qa004-skill-overlap
 */

import type { Skill } from '@slackhive/shared';
import type { CheckContext, HealthcheckIssue } from '../types';

const JACCARD_THRESHOLD = 0.7;

export function runQA004(ctx: CheckContext): HealthcheckIssue[] {
  const tokenized = ctx.skills.map((s) => ({
    skill: s,
    tokens: tokenize(extractDescription(s)),
  }));

  const issues: HealthcheckIssue[] = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const a = tokenized[i];
      const b = tokenized[j];
      if (a.tokens.size === 0 || b.tokens.size === 0) continue;
      const sim = jaccard(a.tokens, b.tokens);
      if (sim >= JACCARD_THRESHOLD) {
        issues.push({
          code: 'QA004',
          severity: 'warn',
          file: skillPath(a.skill),
          message: `Skill description overlaps with "${skillPath(b.skill)}" (Jaccard=${sim.toFixed(2)}). Claude may struggle to disambiguate.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Pulls the description from a skill's markdown content: the first
 * non-empty paragraph that isn't a heading or an HTML comment marker.
 */
function extractDescription(skill: Skill): string {
  const lines = skill.content.split('\n');
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
    paragraph.push(trimmed);
  }
  return paragraph.join(' ');
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function skillPath(skill: Skill): string {
  return `skills/${skill.category}/${skill.filename}`;
}
