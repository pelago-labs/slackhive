import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Corpus, HealthcheckIssue } from '../types';

const VALID_PRIMITIVES = new Set(['substring', 'tool_called', 'llm_judge']);
const VALID_TARGETS = new Set(['final_reply', 'tool_calls']);

const FROM_FIELDS = [
  'contains_from',
  'not_contains_from',
  'must_call_from',
  'must_not_call_from',
] as const;

/**
 * QA009 — Corpus shape.
 *
 * Validates the corpus's `checks:` block:
 *   - Each `primitive:` is one of `substring | tool_called | llm_judge`
 *   - Each `target:` (if present) is one of `final_reply | tool_calls`
 *   - Each `rubric:` path resolves to an existing file (relative to corpus dir)
 *   - Each `<...>_from:` and `case_fields[]` entry references a field
 *     that exists on at least one case (warn if partial coverage, error
 *     if no case has it)
 *
 * Returns no issues when the corpus is missing.
 */
export function runQA009(corpus: Corpus | null): HealthcheckIssue[] {
  if (!corpus) return [];
  const issues: HealthcheckIssue[] = [];
  const corpusDir = dirname(corpus.filePath);

  for (let i = 0; i < corpus.checks.length; i++) {
    const check = corpus.checks[i];
    const tag = `Check #${i + 1}`;

    if (!VALID_PRIMITIVES.has(check.primitive)) {
      issues.push({
        code: 'QA009',
        severity: 'error',
        file: corpus.filePath,
        message: `${tag}: primitive "${check.primitive}" not one of ${[...VALID_PRIMITIVES].join(', ')}`,
      });
    }

    if (check.target !== undefined && !VALID_TARGETS.has(check.target)) {
      issues.push({
        code: 'QA009',
        severity: 'error',
        file: corpus.filePath,
        message: `${tag}: target "${check.target}" not one of ${[...VALID_TARGETS].join(', ')}`,
      });
    }

    if (check.rubric) {
      const rubricPath = resolve(corpusDir, check.rubric);
      if (!existsSync(rubricPath)) {
        issues.push({
          code: 'QA009',
          severity: 'error',
          file: corpus.filePath,
          message: `${tag}: rubric file "${check.rubric}" does not exist (resolved to ${rubricPath})`,
        });
      }
    }

    for (const key of FROM_FIELDS) {
      const fieldName = check[key];
      if (typeof fieldName !== 'string') continue;
      const issueForMissing = scanField(corpus, fieldName);
      if (issueForMissing) {
        issues.push({
          code: 'QA009',
          severity: issueForMissing.severity,
          file: corpus.filePath,
          message: `${tag}: ${key} "${fieldName}" ${issueForMissing.detail}`,
        });
      }
    }

    if (Array.isArray(check.case_fields)) {
      for (const field of check.case_fields) {
        const result = scanField(corpus, field);
        if (result) {
          issues.push({
            code: 'QA009',
            severity: result.severity,
            file: corpus.filePath,
            message: `${tag}: case_fields entry "${field}" ${result.detail}`,
          });
        }
      }
    }
  }

  return issues;
}

function scanField(
  corpus: Corpus,
  field: string,
): { severity: 'error' | 'warn'; detail: string } | null {
  const missing = corpus.cases.filter((c) => !(field in c)).length;
  if (missing === 0) return null;
  if (missing === corpus.cases.length) {
    return { severity: 'error', detail: `not present on any case` };
  }
  return {
    severity: 'warn',
    detail: `missing on ${missing}/${corpus.cases.length} cases`,
  };
}
