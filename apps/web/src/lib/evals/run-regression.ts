/**
 * @fileoverview Tier 2 orchestrator — runs all approved cases for an
 * agent sequentially, aggregates verdicts, persists to the DB.
 *
 * Per case:
 *   1. POST runner /test → consume SSE → produce Trace
 *   2. For each check: evaluateStaticCheck() inline; llm_judge stubbed
 *   3. Case verdict = worst of all check verdicts (PASS > SUSPECT > FAIL > INFRA)
 *   4. Static FAIL beats judge PASS — if any static check FAILed,
 *      skip judges and short-circuit the case to FAIL
 *   5. Persist eval_run_results row
 *   6. Tear down the runner session (best-effort)
 *
 * Sequential v1: cases run one at a time. Parallel is post-v1.
 *
 * @module web/lib/evals/run-regression
 */

import { randomUUID } from 'crypto';
import type {
  CheckConfig,
  CheckResult,
  EvalCase,
  EvalRun,
  EvalRunResult,
  Verdict,
} from '@slackhive/shared';
import {
  DEFAULT_EVAL_JUDGE_MODEL,
  EVAL_JUDGE_MODEL_SETTING_KEY,
} from '@slackhive/shared';
import { getEvalCases, getSetting } from '@/lib/db';
import { evaluateStaticCheck } from './check-primitives';
import { callJudge } from './judge';
import { cleanupCaseSession, runCase, type Trace } from './run-case';

const VERDICT_WORST_ORDER: Verdict[] = ['INFRA', 'FAIL', 'SUSPECT', 'PASS'];

function worst(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return 'INFRA';
  let lowest: Verdict = 'PASS';
  for (const v of verdicts) {
    if (VERDICT_WORST_ORDER.indexOf(v) < VERDICT_WORST_ORDER.indexOf(lowest)) {
      lowest = v;
    }
  }
  return lowest;
}

export interface CaseExecution {
  case: EvalCase;
  trace: Trace;
  results: CheckResult[];
  verdict: Verdict;
  timeMs: number;
}

/**
 * Run one case. Pure: doesn't persist anything. Caller decides what to do
 * with the result.
 */
export async function executeCase(caseRow: EvalCase): Promise<CaseExecution> {
  const startedAt = Date.now();
  const sessionId = randomUUID();
  let trace: Trace;
  try {
    trace = await runCase(caseRow.agentId, caseRow.question, sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      case: caseRow,
      trace: { finalReply: '', toolCalls: [], errored: true, errorMessage: message },
      results: [
        { primitive: 'substring', verdict: 'INFRA', message: `Runner failed: ${message}` },
      ],
      verdict: 'INFRA',
      timeMs: Date.now() - startedAt,
    };
  } finally {
    void cleanupCaseSession(sessionId);
  }

  if (trace.errored) {
    return {
      case: caseRow,
      trace,
      results: [
        { primitive: 'substring', verdict: 'INFRA', message: trace.errorMessage ?? 'Runner error' },
      ],
      verdict: 'INFRA',
      timeMs: Date.now() - startedAt,
    };
  }

  // Phase 1 — static checks
  const staticResults: CheckResult[] = [];
  const judgeIndices: number[] = [];
  for (let i = 0; i < caseRow.checks.length; i++) {
    const check = caseRow.checks[i];
    const result = evaluateStaticCheck(check, trace);
    if (result === null) {
      // llm_judge — defer
      judgeIndices.push(i);
      staticResults.push({} as CheckResult); // placeholder; filled in phase 2
    } else {
      staticResults.push(result);
    }
  }

  // Phase 2 — judges (skipped if any static FAILed; "static FAIL beats judge PASS")
  const anyStaticFailed = staticResults.some(
    (r) => r && (r.verdict === 'FAIL' || r.verdict === 'INFRA'),
  );

  // Load judge model only if we'll actually need it.
  let judgeModel: string | null = null;
  if (judgeIndices.length > 0 && !anyStaticFailed) {
    judgeModel =
      (await getSetting(EVAL_JUDGE_MODEL_SETTING_KEY)) ?? DEFAULT_EVAL_JUDGE_MODEL;
  }

  for (const i of judgeIndices) {
    if (anyStaticFailed) {
      // Skip the judge — would just burn API calls when the case is already FAIL
      staticResults[i] = {
        primitive: 'llm_judge',
        verdict: 'SUSPECT',
        message: 'Skipped — a static check already failed.',
      };
      continue;
    }
    if (!trace.finalReply) {
      // Empty-selector rule for llm_judge: SUSPECT.
      staticResults[i] = {
        primitive: 'llm_judge',
        verdict: 'SUSPECT',
        message: 'Agent produced no reply for the judge to evaluate.',
      };
      continue;
    }
    const check = caseRow.checks[i] as Extract<CheckConfig, { primitive: 'llm_judge' }>;
    try {
      const judgeResult = await callJudge({
        rubric: check.rubric,
        question: caseRow.question,
        finalReply: trace.finalReply,
        groundtruth: check.groundtruth,
        model: judgeModel!,
      });
      staticResults[i] = {
        primitive: 'llm_judge',
        verdict: judgeResult.verdict,
        message: judgeResult.reasoning,
      };
    } catch (err) {
      staticResults[i] = {
        primitive: 'llm_judge',
        verdict: 'INFRA',
        message: `Judge call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    case: caseRow,
    trace,
    results: staticResults,
    verdict: worst(staticResults.map((r) => r.verdict)),
    timeMs: Date.now() - startedAt,
  };
}

/**
 * Convert a CaseExecution into an EvalRunResult row, ready to insert into
 * eval_run_results. The orchestrator (or its caller) fills in `runId`.
 */
export function caseExecutionToRunResult(
  exec: CaseExecution,
  runId: string,
): Omit<EvalRunResult, 'id'> & { id: string } {
  return {
    id: randomUUID(),
    runId,
    caseId: exec.case.id,
    verdict: exec.verdict,
    timeMs: exec.timeMs,
    finalReply: exec.trace.finalReply || undefined,
    toolCalls: exec.trace.toolCalls.length > 0 ? exec.trace.toolCalls : undefined,
    checkResults: exec.results,
    judgeReasoning: undefined,
  };
}

export interface RegressionSummary {
  passCount: number;
  failCount: number;
  suspectCount: number;
  infraCount: number;
}

export function summarize(executions: CaseExecution[]): RegressionSummary {
  return {
    passCount: executions.filter((e) => e.verdict === 'PASS').length,
    failCount: executions.filter((e) => e.verdict === 'FAIL').length,
    suspectCount: executions.filter((e) => e.verdict === 'SUSPECT').length,
    infraCount: executions.filter((e) => e.verdict === 'INFRA').length,
  };
}

/**
 * Top-level: runs all approved cases for an agent sequentially.
 *
 * Does NOT persist anything yet — that's the API route's job (T5).
 * Caller is responsible for creating the eval_runs row, calling this,
 * inserting eval_run_results, and updating the run with the summary.
 */
export async function runApprovedCases(agentId: string): Promise<CaseExecution[]> {
  const cases = await getEvalCases(agentId, { status: 'approved' });
  const out: CaseExecution[] = [];
  for (const c of cases) {
    out.push(await executeCase(c));
  }
  return out;
}
