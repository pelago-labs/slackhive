import { join } from 'node:path';
import type { AgentConfig, HealthcheckIssue, Skill } from '../types';

const JACCARD_THRESHOLD = 0.7;

/**
 * QA004 — Skill description overlap.
 *
 * Tokenizes each skill's description, computes Jaccard similarity on every
 * pair, reports pairs with similarity ≥ 0.7. When two skills look almost
 * identical to Claude, it can't reliably pick between them — one of the
 * skills will be silently shadowed.
 *
 * Severity: warn (Jaccard has a known false-positive tail; start
 * conservative — see V1-DESIGN.md "Embedding-based skill overlap" deferral).
 */
export function runQA004(config: AgentConfig): HealthcheckIssue[] {
  const tokenized = config.skills.map((s) => ({
    skill: s,
    tokens: tokenize(s.description),
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
          file: skillPath(config.dir, a.skill),
          message: `Skill description overlaps with "${b.skill.path}" (Jaccard=${sim.toFixed(2)}). Claude may struggle to disambiguate.`,
        });
      }
    }
  }
  return issues;
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

function skillPath(agentDir: string, skill: Skill): string {
  return join(agentDir, 'skills', skill.path);
}
