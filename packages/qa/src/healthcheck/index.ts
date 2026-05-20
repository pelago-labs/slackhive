import { join } from 'node:path';
import type { AgentConfig, Corpus, HealthcheckIssue } from '../types';
import { runQA001 } from './qa001-mcp-coverage';
import { runQA002 } from './qa002-cross-refs';
import { runQA003 } from './qa003-trigger-conflicts';
import { runQA004 } from './qa004-skill-overlap';
import { runQA005 } from './qa005-persona-hygiene';
import { runQA006 } from './qa006-tool-prefix';
import { runQA007 } from './qa007-wiki-coverage';
import { runQA008 } from './qa008-test-coverage';
import { runQA009 } from './qa009-corpus-shape';

/**
 * Runs all 9 Tier 1 healthcheck checks against an agent and its corpus.
 *
 * Aggregator-level concerns:
 *   - If a corpus file existed but failed to load (e.g., wrong top-level
 *     shape), this surfaces as a QA009 issue. Corpus-dependent checks
 *     (QA008, QA009) are skipped in that case.
 *   - Returns issues in QA001 → QA009 order so the reporter's output is
 *     stable across runs.
 */
export function runHealthcheck(
  config: AgentConfig,
  corpus: Corpus | null,
  corpusError?: string,
): HealthcheckIssue[] {
  const issues: HealthcheckIssue[] = [];

  if (corpusError) {
    issues.push({
      code: 'QA009',
      severity: 'error',
      file: join(config.dir, 'eval', 'tests.yaml'),
      message: `Corpus failed to load: ${corpusError}`,
    });
  }

  issues.push(...runQA001(config));
  issues.push(...runQA002(config));
  issues.push(...runQA003(config));
  issues.push(...runQA004(config));
  issues.push(...runQA005(config));
  issues.push(...runQA006(config));
  issues.push(...runQA007(config));

  if (corpus) {
    issues.push(...runQA008(config, corpus));
    issues.push(...runQA009(corpus));
  }

  return issues;
}
