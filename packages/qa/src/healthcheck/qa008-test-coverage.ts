import { join } from 'node:path';
import type { AgentConfig, Corpus, HealthcheckIssue } from '../types';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'for', 'and', 'or', 'but',
  'that', 'this', 'it', 'with', 'at', 'by', 'from', 'as', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'may', 'might', 'must', 'shall', 'not', 'no',
  'if', 'then', 'else', 'when', 'where', 'what', 'which', 'who', 'whom',
  'how', 'why', 'all', 'any', 'each', 'every', 'some', 'many', 'few', 'one',
  'two', 'agent', 'skill', 'use', 'used', 'using',
]);

/**
 * QA008 — Test coverage.
 *
 * For every Step 0 trigger and every skill, check whether at least one
 * approved test case appears to exercise it.
 *
 *   - Trigger is covered iff some case's question contains the trigger phrase as substring
 *   - Skill is covered iff some meaningful token from its name or description
 *     appears as substring in any case's question (stopword-filtered, min length 3)
 *
 * Severity: warn — heuristic-based; agents under active development
 * often have coverage gaps that are known and acceptable. Useful as a
 * signal, not a gate. Returns no issues when the corpus is missing.
 */
export function runQA008(config: AgentConfig, corpus: Corpus | null): HealthcheckIssue[] {
  if (!corpus || corpus.cases.length === 0) return [];
  const issues: HealthcheckIssue[] = [];

  const questions = corpus.cases.map((c) => c.question.toLowerCase()).join(' \n ');

  for (const trigger of config.claudeMd.triggers) {
    if (!questions.includes(trigger.toLowerCase())) {
      issues.push({
        code: 'QA008',
        severity: 'warn',
        file: join(config.dir, 'CLAUDE.md'),
        message: `Step 0 trigger "${trigger}" has no test case`,
      });
    }
  }

  for (const skill of config.skills) {
    const tokens = meaningfulTokens(
      skill.name.replace(/-/g, ' ') + ' ' + skill.description,
    );
    if (tokens.length === 0) continue;
    const covered = tokens.some((t) => questions.includes(t));
    if (!covered) {
      issues.push({
        code: 'QA008',
        severity: 'warn',
        file: join(config.dir, 'skills', skill.path),
        message: `Skill "${skill.name}" not referenced by any test case`,
      });
    }
  }

  return issues;
}

function meaningfulTokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  );
}
