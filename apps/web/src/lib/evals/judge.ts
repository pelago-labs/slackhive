/**
 * @fileoverview Web-side caller for the Tier 2 LLM judge.
 *
 * Wraps the HTTP fetch to the runner's /judge endpoint. The runner does
 * the actual Claude SDK call — credentials and the SDK live there.
 *
 * @module web/lib/evals/judge
 */

import type { Verdict } from '@slackhive/shared';
import { runnerBase } from '@/lib/runner';

export interface JudgeInput {
  rubric: string;
  question: string;
  finalReply: string;
  groundtruth?: string;
  model: string;
}

export interface JudgeResult {
  verdict: Verdict;
  reasoning: string;
}

/**
 * Calls the runner's /judge endpoint. Throws if the runner is unreachable
 * or returns non-2xx. The caller (orchestrator) maps thrown errors into
 * INFRA verdicts.
 */
export async function callJudge(input: JudgeInput): Promise<JudgeResult> {
  const res = await fetch(`${runnerBase()}/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Runner /judge responded ${res.status} ${res.statusText}: ${text}`);
  }
  const body = (await res.json()) as { verdict?: unknown; reasoning?: unknown };
  if (
    body.verdict !== 'PASS' &&
    body.verdict !== 'FAIL' &&
    body.verdict !== 'SUSPECT' &&
    body.verdict !== 'INFRA'
  ) {
    throw new Error(`Judge returned invalid verdict: ${String(body.verdict)}`);
  }
  return {
    verdict: body.verdict,
    reasoning: typeof body.reasoning === 'string' ? body.reasoning : '',
  };
}
