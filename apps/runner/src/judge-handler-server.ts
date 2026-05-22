/**
 * @fileoverview Runner endpoint for the Tier 2 LLM judge.
 *
 * One-shot JSON request → JSON response. Unlike /coach and /test, this
 * does NOT stream SSE — the judge call is short, the orchestrator wants
 * a single verdict back.
 *
 * Request body:
 *   { rubric: string, question: string, finalReply: string,
 *     groundtruth?: string, model: string }
 *
 * Response body:
 *   { verdict: 'PASS' | 'FAIL' | 'SUSPECT', reasoning: string }
 *
 * The handler shells out to Claude via @anthropic-ai/claude-agent-sdk
 * (same SDK Coach uses). No tools, no MCP — pure text-in/text-out.
 *
 * @module runner/judge-handler-server
 */

import type { ServerResponse } from 'http';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Verdict } from '@slackhive/shared';
import { logger } from './logger';

interface JudgeRequest {
  rubric: string;
  question: string;
  finalReply: string;
  groundtruth?: string;
  model: string;
}

/**
 * Judge's verdict is always one of PASS / FAIL / SUSPECT.
 * INFRA is reserved for orchestrator-level failures (judge call threw,
 * runner unreachable, etc) and is set by the caller, never returned here.
 */
type JudgeVerdict = Exclude<Verdict, 'INFRA'>;

interface JudgeResponse {
  verdict: JudgeVerdict;
  reasoning: string;
}

const MAX_REASONING_LEN = 2000;

export async function handleJudge(body: string, res: ServerResponse): Promise<void> {
  let req: JudgeRequest;
  try {
    req = JSON.parse(body) as JudgeRequest;
  } catch {
    writeJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  if (!req.rubric || !req.question || !req.finalReply || !req.model) {
    writeJson(res, 400, {
      error: 'rubric, question, finalReply, model are required',
    });
    return;
  }

  const prompt = buildJudgePrompt(req);

  let assistantText = '';
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: req.model,
        allowedTools: [],
        permissionMode: 'dontAsk',
        maxTurns: 1,
      },
    })) {
      const m = msg as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text;
          }
        }
      }
    }
  } catch (err) {
    logger.error('Judge query failed', { error: (err as Error).message });
    writeJson(res, 500, { error: (err as Error).message });
    return;
  }

  const parsed = parseJudgeOutput(assistantText);
  writeJson(res, 200, parsed);
}

function buildJudgePrompt(req: JudgeRequest): string {
  const parts = [
    "You are an evaluator grading an AI agent's response to a question.",
    '',
    '# Rubric',
    req.rubric,
    '',
    '# Question (what the user asked)',
    req.question,
    '',
    "# Agent's response",
    req.finalReply,
  ];
  if (req.groundtruth) {
    parts.push('', '# Reference answer (for context)', req.groundtruth);
  }
  parts.push(
    '',
    '# Your task',
    'Grade the response against the rubric. Output exactly one JSON object:',
    '{"verdict": "PASS" | "FAIL" | "SUSPECT", "reasoning": "<one short paragraph>"}',
    '',
    '- PASS: response satisfies the rubric',
    '- FAIL: response clearly does not satisfy the rubric',
    '- SUSPECT: uncertain, ambiguous, or partially right',
    '',
    'Output ONLY the JSON object. No prose before or after, no markdown fences.',
  );
  return parts.join('\n');
}

function parseJudgeOutput(text: string): JudgeResponse {
  // Strip markdown fences if Claude added them despite instructions.
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  // Take from first { to last } — robust to leading/trailing prose.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return {
      verdict: 'SUSPECT',
      reasoning: `Judge output did not contain JSON. Raw: ${text.slice(0, 300)}`,
    };
  }
  const json = cleaned.slice(start, end + 1);
  try {
    const obj = JSON.parse(json) as { verdict?: unknown; reasoning?: unknown };
    const verdict = obj.verdict;
    if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'SUSPECT') {
      return {
        verdict: 'SUSPECT',
        reasoning: `Judge returned invalid verdict "${String(verdict)}". Raw reasoning: ${String(obj.reasoning ?? '').slice(0, 500)}`,
      };
    }
    const reasoning = String(obj.reasoning ?? '').slice(0, MAX_REASONING_LEN);
    return { verdict, reasoning };
  } catch (err) {
    return {
      verdict: 'SUSPECT',
      reasoning: `Could not parse judge JSON: ${(err as Error).message}`,
    };
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
