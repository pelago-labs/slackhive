/**
 * @fileoverview QA005 — Persona hygiene.
 *
 * Scans `claudeMd` and every skill for banned patterns that indicate
 * dangerous instructions (force-push, --no-verify, rm -rf),
 * prompt-injection markers (ignore previous/prior), system-override
 * attempts, or sycophantic directives (always agree).
 *
 * @module web/lib/evals/checks/qa005-persona-hygiene
 */

import type { CheckContext, HealthcheckIssue } from '../types';

const BANNED: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\bforce[ -]push\b/i, description: 'force-push (risky git operation)' },
  { pattern: /--no-verify\b/i, description: '--no-verify (skips git hooks)' },
  { pattern: /\brm\s+-rf\b/i, description: 'rm -rf (destructive command)' },
  { pattern: /\bignore (?:previous|prior)\b/i, description: 'prompt-injection marker (ignore previous/prior)' },
  { pattern: /\bsystem[- ]override\b/i, description: 'system override marker' },
  { pattern: /\balways agree\b/i, description: 'always-agree directive' },
];

export function runQA005(ctx: CheckContext): HealthcheckIssue[] {
  const issues: HealthcheckIssue[] = [];

  const files: Array<{ file: string; raw: string }> = [
    { file: 'CLAUDE.md', raw: ctx.parsedClaudeMd.raw },
    ...ctx.skills.map((s) => ({
      file: `skills/${s.category}/${s.filename}`,
      raw: s.content,
    })),
  ];

  for (const { file, raw } of files) {
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { pattern, description } of BANNED) {
        const m = lines[i].match(pattern);
        if (m) {
          issues.push({
            code: 'QA005',
            severity: 'error',
            file,
            line: i + 1,
            message: `Banned pattern: ${description} — matched "${m[0]}"`,
          });
        }
      }
    }
  }

  return issues;
}
