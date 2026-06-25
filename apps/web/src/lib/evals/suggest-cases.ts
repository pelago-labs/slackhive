/**
 * @fileoverview Web-side caller + validator/translator for the
 * suggest-cases runner endpoint.
 *
 * Runner returns "wire cases" in the UI's check-type vocabulary.
 * This module validates them against agent-specific rules (known MCP
 * tool names, non-empty fields) and translates to framework CheckConfig
 * shapes ready for createEvalCase().
 *
 * @module web/lib/evals/suggest-cases
 */

import type {
  CheckConfig,
  SuggestedCaseWire,
  SuggestedCheck,
} from '@slackhive/shared';
import { runnerBase } from '@/lib/runner';

interface SuggestRunnerRequest {
  agent: {
    name: string;
    description?: string;
    persona?: string;
    claudeMd: string;
  };
  skills: Array<{ category: string; filename: string; content: string }>;
  wikiSources: Array<{ name: string; content?: string }>;
  mcps: Array<{ name: string; description?: string }>;
  existingQuestions: string[];
  count: number;
  model: string;
}

/** A suggested case after validation + translation. Ready to persist. */
export interface SuggestedCase {
  question: string;
  checks: CheckConfig[];
}

/**
 * POSTs to runner /suggest-cases. Returns raw wire cases; caller validates.
 */
async function callRunner(req: SuggestRunnerRequest): Promise<SuggestedCaseWire[]> {
  const res = await fetch(`${runnerBase()}/suggest-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Runner /suggest-cases responded ${res.status} ${res.statusText}: ${text}`);
  }
  const body = (await res.json()) as { cases?: SuggestedCaseWire[] };
  return Array.isArray(body.cases) ? body.cases : [];
}

/**
 * Validates one wire case + translates to CheckConfig.
 * Returns `null` if the case should be dropped silently.
 */
function validateAndTranslate(
  raw: SuggestedCaseWire,
  validMcpToolPrefixes: Set<string>,
): SuggestedCase | null {
  if (typeof raw.question !== 'string' || raw.question.trim() === '') return null;
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) return null;

  // Partial salvage: invalid individual checks are dropped, but the case
  // survives as long as at least one check passes validation.
  const translated: CheckConfig[] = [];
  for (const raw_check of raw.checks) {
    const c = translateCheck(raw_check, validMcpToolPrefixes);
    if (c !== null) translated.push(c);
  }
  if (translated.length === 0) return null;
  return { question: raw.question.trim(), checks: translated };
}

function translateCheck(
  raw: SuggestedCheck,
  validMcpToolPrefixes: Set<string>,
): CheckConfig | null {
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return null;

  if (raw.type === 'substring_contain') {
    const phrases = cleanStringArray(raw.phrases);
    if (phrases.length === 0) return null;
    return { primitive: 'substring', target: 'final_reply', must_contain: phrases };
  }
  if (raw.type === 'substring_not_contain') {
    const phrases = cleanStringArray(raw.phrases);
    if (phrases.length === 0) return null;
    return { primitive: 'substring', target: 'final_reply', must_not_contain: phrases };
  }
  if (raw.type === 'tool_called') {
    const tools = cleanStringArray(raw.tools).filter((t) =>
      toolBelongsToLinkedMcp(t, validMcpToolPrefixes),
    );
    if (tools.length === 0) return null;
    return { primitive: 'tool_called', must_call: tools };
  }
  if (raw.type === 'tool_not_called') {
    const tools = cleanStringArray(raw.tools).filter((t) =>
      toolBelongsToLinkedMcp(t, validMcpToolPrefixes),
    );
    if (tools.length === 0) return null;
    return { primitive: 'tool_called', must_not_call: tools };
  }
  if (raw.type === 'llm_judge') {
    const rubric = typeof raw.rubric === 'string' ? raw.rubric.trim() : '';
    if (rubric === '') return null;
    const groundtruth =
      typeof raw.groundtruth === 'string' && raw.groundtruth.trim()
        ? raw.groundtruth.trim()
        : undefined;
    return {
      primitive: 'llm_judge',
      target: 'final_reply',
      rubric,
      ...(groundtruth ? { groundtruth } : {}),
    };
  }
  return null;
}

function cleanStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((s) => typeof s === 'string')
    .map((s) => (s as string).trim())
    .filter((s) => s.length > 0);
}

/**
 * Tool id must start with `mcp__<server>__` where <server> is one of the
 * agent's linked MCPs. Anything else means the model hallucinated a
 * server name — drop it.
 */
function toolBelongsToLinkedMcp(tool: string, prefixes: Set<string>): boolean {
  if (!tool.startsWith('mcp__')) return false;
  const secondUnderscore = tool.indexOf('__', 5);
  if (secondUnderscore === -1) return false;
  const server = tool.slice(5, secondUnderscore);
  return prefixes.has(server);
}

/**
 * Top-level: takes the assembled context, calls the runner, validates +
 * translates the wire cases, returns the cases ready to persist.
 */
export async function suggestCases(input: {
  agent: SuggestRunnerRequest['agent'];
  skills: SuggestRunnerRequest['skills'];
  wikiSources: SuggestRunnerRequest['wikiSources'];
  mcps: SuggestRunnerRequest['mcps'];
  existingQuestions: string[];
  count: number;
  model: string;
}): Promise<SuggestedCase[]> {
  const wireCases = await callRunner(input);
  const validPrefixes = new Set(input.mcps.map((m) => m.name));
  const out: SuggestedCase[] = [];
  for (const raw of wireCases) {
    const c = validateAndTranslate(raw, validPrefixes);
    if (c !== null) out.push(c);
  }
  return out;
}
