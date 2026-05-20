import { join } from 'node:path';
import type { AgentConfig, HealthcheckIssue } from '../types';

/**
 * QA003 — Trigger conflicts.
 *
 * For each pair of Step 0 triggers parsed from CLAUDE.md, detect two
 * conflict shapes:
 *   - exact duplicate (same trigger phrase listed twice)
 *   - prefix overlap (one trigger is a strict prefix of another, separated
 *     by a space — meaning user input that matches the longer one also
 *     matches the shorter one)
 *
 * Severity: error.
 *
 * Limitation: no line number, since the loader extracts triggers from
 * Step 0 but does not retain per-trigger source position. v1 acceptable.
 */
export function runQA003(config: AgentConfig): HealthcheckIssue[] {
  const triggers = config.claudeMd.triggers.map((t) => t.toLowerCase());
  const issues: HealthcheckIssue[] = [];
  const filePath = join(config.dir, 'CLAUDE.md');

  for (let i = 0; i < triggers.length; i++) {
    for (let j = i + 1; j < triggers.length; j++) {
      const a = triggers[i];
      const b = triggers[j];
      if (a === b) {
        issues.push({
          code: 'QA003',
          severity: 'error',
          file: filePath,
          message: `Duplicate Step 0 trigger: "${a}"`,
        });
      } else if (b.startsWith(a + ' ') || a.startsWith(b + ' ')) {
        issues.push({
          code: 'QA003',
          severity: 'error',
          file: filePath,
          message: `Overlapping Step 0 triggers: "${a}" and "${b}" — one is a prefix of the other`,
        });
      }
    }
  }
  return issues;
}
