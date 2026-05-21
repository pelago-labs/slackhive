/**
 * @fileoverview QA003 — Trigger conflicts.
 *
 * For each pair of Step 0 triggers parsed from `claudeMd`, detect:
 *   - exact duplicate (same phrase listed twice)
 *   - prefix overlap (one trigger is a strict prefix of another,
 *     separated by a space — input matching the longer one also
 *     matches the shorter one)
 *
 * Severity: error. No line number; the parser extracts triggers
 * but doesn't retain per-trigger source positions (v1 acceptable).
 *
 * @module web/lib/evals/checks/qa003-trigger-conflicts
 */

import type { CheckContext, HealthcheckIssue } from '../types';

export function runQA003(ctx: CheckContext): HealthcheckIssue[] {
  const triggers = ctx.parsedClaudeMd.triggers.map((t) => t.toLowerCase());
  const issues: HealthcheckIssue[] = [];

  for (let i = 0; i < triggers.length; i++) {
    for (let j = i + 1; j < triggers.length; j++) {
      const a = triggers[i];
      const b = triggers[j];
      if (a === b) {
        issues.push({
          code: 'QA003',
          severity: 'error',
          file: 'CLAUDE.md',
          message: `Duplicate Step 0 trigger: "${a}"`,
        });
      } else if (b.startsWith(a + ' ') || a.startsWith(b + ' ')) {
        issues.push({
          code: 'QA003',
          severity: 'error',
          file: 'CLAUDE.md',
          message: `Overlapping Step 0 triggers: "${a}" and "${b}" — one is a prefix of the other`,
        });
      }
    }
  }
  return issues;
}
