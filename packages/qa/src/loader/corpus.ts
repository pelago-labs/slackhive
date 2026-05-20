import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { Case, CheckConfig, Corpus } from '../types';

export type LoadCorpusOptions = {
  includeProposed?: boolean;
};

export function loadCorpus(agentDir: string, opts: LoadCorpusOptions = {}): Corpus | null {
  const filePath = join(agentDir, 'eval', 'tests.yaml');
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = load(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid corpus shape at ${filePath} — expected object with checks/cases`);
  }

  const obj = parsed as { checks?: unknown; cases?: unknown };
  const checks = Array.isArray(obj.checks) ? (obj.checks as CheckConfig[]) : [];
  const allCases = Array.isArray(obj.cases) ? (obj.cases as Case[]) : [];

  const cases = opts.includeProposed
    ? allCases
    : allCases.filter((c) => c.status === 'approved');

  return {
    filePath,
    fileMtime: statSync(filePath).mtimeMs,
    checks,
    cases,
  };
}
