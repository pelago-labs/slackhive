import type { HealthcheckIssue } from '../types';

export type Summary = {
  total: number;
  errors: number;
  warnings: number;
};

export function summarize(issues: HealthcheckIssue[]): Summary {
  return {
    total: issues.length,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warn').length,
  };
}

/**
 * eslint-style output: groups issues by file, then prints each as
 * `<line>:1   <severity>   <code>   <message>`.
 *
 * Issues without a `line` are anchored at line 1 of their file.
 */
export function reportEslintStyle(issues: HealthcheckIssue[]): string {
  if (issues.length === 0) return '✓ No issues found.';

  const grouped = new Map<string, HealthcheckIssue[]>();
  for (const issue of issues) {
    const list = grouped.get(issue.file) ?? [];
    list.push(issue);
    grouped.set(issue.file, list);
  }

  const lines: string[] = [];
  for (const [file, fileIssues] of grouped) {
    lines.push(file);
    for (const i of fileIssues) {
      const loc = `${i.line ?? 1}:1`;
      lines.push(
        `  ${loc.padEnd(7)} ${i.severity.padEnd(5)}  ${i.code.padEnd(6)}  ${i.message}`,
      );
    }
    lines.push('');
  }

  const s = summarize(issues);
  lines.push(
    `✖ ${s.total} problem${s.total === 1 ? '' : 's'} ` +
      `(${s.errors} error${s.errors === 1 ? '' : 's'}, ` +
      `${s.warnings} warning${s.warnings === 1 ? '' : 's'})`,
  );

  return lines.join('\n');
}

/**
 * JSON output: machine-parseable for CI / future web consumers.
 */
export function reportJson(issues: HealthcheckIssue[]): string {
  return JSON.stringify(
    {
      summary: summarize(issues),
      issues,
    },
    null,
    2,
  );
}
