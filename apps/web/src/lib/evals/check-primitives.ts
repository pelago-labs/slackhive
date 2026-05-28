/**
 * @fileoverview Tier 2 check primitives.
 *
 * Two of the three primitives are fully implemented here:
 *   - substring   (deterministic — final_reply selector)
 *   - tool_called (deterministic — tool_calls selector, supports `*` suffix wildcards)
 *
 * The third (llm_judge) lives outside this module because it needs an
 * out-of-process call to Claude via the runner. The orchestrator (T4)
 * decides when to invoke the judge — specifically, *not* when any
 * static check has already FAILed ("static FAIL beats judge PASS").
 *
 * Empty-selector handling:
 *   substring   — FAIL (no reply to check)
 *   tool_called — verdict is per-pattern, so:
 *                   `must_call`     with no tools called → FAIL (expected calls absent)
 *                   `must_not_call` with no tools called → PASS (vacuously satisfied)
 *   llm_judge   — SUSPECT (handled by the orchestrator/judge wiring)
 *
 * Returns `null` for llm_judge so the caller knows to dispatch
 * asynchronously rather than treating it as a static result.
 *
 * @module web/lib/evals/check-primitives
 */

import type { CheckConfig, CheckResult, ToolCallTrace } from '@slackhive/shared';
import type { Trace } from './run-case';

/**
 * Evaluate one static check against a trace.
 * Returns `null` if the check is `llm_judge` (caller dispatches separately).
 */
export function evaluateStaticCheck(
  check: CheckConfig,
  trace: Trace,
): CheckResult | null {
  if (check.primitive === 'substring') {
    return checkSubstring(check, trace.finalReply);
  }
  if (check.primitive === 'tool_called') {
    return checkToolCalled(check, trace.toolCalls);
  }
  return null;
}

function checkSubstring(
  check: Extract<CheckConfig, { primitive: 'substring' }>,
  finalReply: string,
): CheckResult {
  if (!finalReply) {
    return {
      primitive: 'substring',
      verdict: 'FAIL',
      message: 'Agent produced no final reply — nothing to check.',
    };
  }
  const reply = finalReply.toLowerCase();

  const missing: string[] = [];
  for (const phrase of check.must_contain ?? []) {
    if (!reply.includes(phrase.toLowerCase())) missing.push(phrase);
  }

  const present: string[] = [];
  for (const phrase of check.must_not_contain ?? []) {
    if (reply.includes(phrase.toLowerCase())) present.push(phrase);
  }

  if (missing.length === 0 && present.length === 0) {
    return { primitive: 'substring', verdict: 'PASS' };
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing: ${missing.map((p) => `"${p}"`).join(', ')}`);
  }
  if (present.length > 0) {
    parts.push(`forbidden present: ${present.map((p) => `"${p}"`).join(', ')}`);
  }
  return { primitive: 'substring', verdict: 'FAIL', message: parts.join('; ') };
}

function checkToolCalled(
  check: Extract<CheckConfig, { primitive: 'tool_called' }>,
  toolCalls: ToolCallTrace[],
): CheckResult {
  // No blanket FAIL on empty toolCalls — must_not_call should pass
  // vacuously when no tools were invoked. Verdict falls out of the
  // per-pattern check below.
  const calledIds = new Set(toolCalls.map((t) => t.toolId));

  const missing: string[] = [];
  for (const tool of check.must_call ?? []) {
    if (!toolMatches(tool, calledIds)) missing.push(tool);
  }

  const present: string[] = [];
  for (const tool of check.must_not_call ?? []) {
    if (toolMatches(tool, calledIds)) present.push(tool);
  }

  if (missing.length === 0 && present.length === 0) {
    return { primitive: 'tool_called', verdict: 'PASS' };
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`not called: ${missing.join(', ')}`);
  }
  if (present.length > 0) {
    parts.push(`forbidden called: ${present.join(', ')}`);
  }
  return { primitive: 'tool_called', verdict: 'FAIL', message: parts.join('; ') };
}

/**
 * Tool-id pattern matcher. Supports a trailing `*` as a suffix wildcard
 * so users can write `mcp__github__*` to mean "any tool from the github
 * MCP server". Exact match otherwise.
 */
function toolMatches(pattern: string, calledIds: Set<string>): boolean {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    for (const id of calledIds) {
      if (id.startsWith(prefix)) return true;
    }
    return false;
  }
  return calledIds.has(pattern);
}

