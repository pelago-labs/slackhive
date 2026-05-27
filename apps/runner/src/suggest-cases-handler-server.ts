/**
 * @fileoverview Runner endpoint for LLM-generated test case suggestions.
 *
 * One-shot JSON in, JSON out. Takes the agent's full picture (description,
 * persona, claudeMd, skills, wiki sources, linked MCPs) and asks Claude
 * to design N test cases composed of the 5 user-facing check types.
 *
 * Output is in the UI's check-type vocabulary (substring_contain,
 * substring_not_contain, tool_called, tool_not_called, llm_judge);
 * the web side translates these into framework CheckConfig shapes
 * before persisting.
 *
 * Uses the same Claude Agent SDK pattern as /judge — no tools, no MCP,
 * maxTurns: 1, plain text-in/text-out.
 *
 * @module runner/suggest-cases-handler-server
 */

import type { ServerResponse } from 'http';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SuggestedCaseWire } from '@slackhive/shared';
import { logger } from './logger';

interface SuggestCasesRequest {
  agent: {
    name: string;
    description?: string;
    persona?: string;
    claudeMd: string;
  };
  skills: Array<{ category: string; filename: string; content: string }>;
  wikiSources: Array<{ name: string; content?: string }>;
  mcps: Array<{ name: string; description?: string }>;
  existingQuestions?: string[];
  count: number;
  model: string;
}

interface SuggestCasesResponse {
  cases: SuggestedCaseWire[];
}

export async function handleSuggestCases(
  body: string,
  res: ServerResponse,
): Promise<void> {
  let req: SuggestCasesRequest;
  try {
    req = JSON.parse(body) as SuggestCasesRequest;
  } catch {
    writeJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  if (!req.agent?.claudeMd || !req.model || !req.count || req.count < 1) {
    writeJson(res, 400, {
      error: 'agent.claudeMd, count (>=1), and model are required',
    });
    return;
  }

  const prompt = buildSuggestPrompt(req);

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
      const m = msg as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text;
          }
        }
      }
    }
  } catch (err) {
    logger.error('Suggest-cases query failed', { error: (err as Error).message });
    writeJson(res, 500, { error: (err as Error).message });
    return;
  }

  const parsed = parseSuggestOutput(assistantText);
  logger.info('Suggest-cases produced', {
    requestedCount: req.count,
    parsedCount: parsed.cases.length,
  });
  writeJson(res, 200, parsed);
}

function buildSuggestPrompt(req: SuggestCasesRequest): string {
  const skillsBlock = req.skills.length
    ? req.skills
        .map(
          (s) =>
            `### skills/${s.category}/${s.filename}\n${truncate(s.content, 2000)}`,
        )
        .join('\n\n')
    : '_(no skills)_';

  const wikiBlock = req.wikiSources.length
    ? req.wikiSources
        .map((w) => `### wiki/${w.name}\n${truncate(w.content ?? '', 800)}`)
        .join('\n\n')
    : '_(no wiki sources)_';

  const mcpsBlock = req.mcps.length
    ? req.mcps
        .map((m) => `- ${m.name}${m.description ? ` — ${m.description}` : ''}`)
        .join('\n')
    : '_(no linked MCPs)_';

  const existing = (req.existingQuestions ?? []).filter(
    (q) => typeof q === 'string' && q.trim() !== '',
  );
  const existingBlock = existing.length
    ? existing.map((q) => `- ${truncate(q, 240)}`).join('\n')
    : '';

  return [
    'You are designing test cases for an AI agent that runs in Slack.',
    'Generate test cases that exercise the agent against realistic Slack user inputs.',
    '',
    '# Agent context',
    `Name: ${req.agent.name}`,
    req.agent.description ? `Description: ${req.agent.description}` : '',
    req.agent.persona ? `Persona: ${req.agent.persona}` : '',
    '',
    '## CLAUDE.md (the agent instructions)',
    truncate(req.agent.claudeMd, 6000),
    '',
    `## Skills (${req.skills.length})`,
    skillsBlock,
    '',
    `## Linked wiki sources (${req.wikiSources.length})`,
    wikiBlock,
    '',
    `## Linked MCP servers (${req.mcps.length})`,
    mcpsBlock,
    'Tool name format: mcp__<server>__<tool>',
    'When using tool_called / tool_not_called, ONLY reference tools from servers listed above.',
    '',
    existingBlock
      ? `## Existing cases (${existing.length}) — these angles are TAKEN`
      : '',
    existingBlock,
    existingBlock
      ? [
          'The new case MUST come from a genuinely different territory than every case above. Be strict about what "different" means:',
          '',
          'COUNTS AS THE SAME ANGLE (reject — do not generate this):',
          '- Same metric/topic with different parameters (different country, region, date range, time window, user segment, currency).',
          '  Example: existing "What\'s our GMV last 30 days by country?" → "What\'s our GMV for Japan last 7 days?" is the SAME angle. So is any other GMV-by-X question.',
          '- Same intent with different phrasing (both asking for a top-N ranking, both asking for a comparison, both asking for a definition).',
          '- Same edge case rephrased.',
          '',
          'COUNTS AS A DIFFERENT ANGLE (good — pick one of these):',
          '- A different metric / object / behavior (e.g., if existing is about GMV, try sessions, refunds, funnel conversion, cohort retention, a categorical dimension breakdown, or a non-numeric question).',
          '- A different question shape: ambiguity / clarification / refusal / abuse / missing context / impossible request / format constraint / conflicting instructions / multi-step reasoning / "what does this term mean".',
          '- A different agent behavior to exercise (e.g., a question that should trigger a tool that hasn\'t been exercised yet, or one that should NOT trigger any tool).',
          '',
          'If you find yourself parameterizing an existing question — STOP and pick from a different family entirely. The whole point is to broaden coverage, not deepen one topic.',
        ].join('\n')
      : '',
    '',
    '# Available check types',
    '',
    '1. **substring_contain** — the agent\'s reply must contain ALL listed phrases (case-insensitive).',
    '   `{ "type": "substring_contain", "phrases": ["..."] }`',
    '',
    '2. **substring_not_contain** — the agent\'s reply must NOT contain any of the listed phrases.',
    '   `{ "type": "substring_not_contain", "phrases": ["..."] }`',
    '',
    '3. **tool_called** — the agent MUST call all listed MCP tools during the response.',
    '   `{ "type": "tool_called", "tools": ["mcp__server__tool"] }`',
    '',
    '4. **tool_not_called** — the agent must NOT call any of the listed MCP tools.',
    '   `{ "type": "tool_not_called", "tools": ["mcp__server__tool"] }`',
    '',
    '5. **llm_judge** — a separate LLM grades the response against your rubric.',
    '   `{ "type": "llm_judge", "rubric": "<plain English judging instructions>", "groundtruth": "<optional example answer>" }`',
    '',
    '# Your task',
    '',
    `Design exactly ${req.count} test ${req.count === 1 ? 'case' : 'cases'}. Each case must have:`,
    '- A `question`: the literal Slack message a user would send (1-2 sentences).',
    '- A `checks` array with 1-3 checks. Cases that exercise different aspects of the agent are more valuable.',
    '',
    'Aim for variety:',
    '- Prefer mixing deterministic checks (substring / tool_called) with at least one llm_judge for semantic cases.',
    '- A good case has SPECIFIC expectations grounded in the agent context above.',
    '- Avoid generic checks like "reply must contain hello" unless that\'s actually relevant.',
    '',
    'Output ONLY this JSON object, no markdown fences, no prose:',
    '{"cases":[{"question":"...","checks":[...]},...]}',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n[...truncated]';
}

function parseSuggestOutput(text: string): SuggestCasesResponse {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { cases: [] };
  }
  const json = cleaned.slice(start, end + 1);
  try {
    const obj = JSON.parse(json) as { cases?: unknown };
    if (!Array.isArray(obj.cases)) return { cases: [] };
    // Trust the wire shape; the web side validates against MCP/check rules.
    return { cases: obj.cases as SuggestedCaseWire[] };
  } catch (err) {
    logger.warn('Suggest-cases JSON parse failed', { error: (err as Error).message });
    return { cases: [] };
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
