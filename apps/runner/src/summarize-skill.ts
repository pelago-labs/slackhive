/**
 * @fileoverview Skill description summarizer.
 *
 * Calls Claude Sonnet 4.6 via `@anthropic-ai/claude-agent-sdk` (same auth as
 * the rest of the runner — works with both ANTHROPIC_API_KEY and host-side
 * `claude login`) and gets back a one-line ≤80-char description for a skill.
 *
 * Used by the runner subscriber when a `skill-saved` event fires, by the
 * startup sweep for legacy rows, and by the standalone backfill script.
 *
 * Returns `null` on any failure path so callers can leave the description
 * NULL and fall back to name-only rendering in the compiled CLAUDE.md.
 *
 * @module runner/summarize-skill
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from './logger';

const MODEL = 'claude-sonnet-4-6';
const MAX_CHARS = 80;

const SYSTEM_PROMPT = `You write one-line descriptions of a developer's "skill" \
(a slash-command playbook). Output ONE sentence in plain text, no markdown, no \
quotes, no trailing period. Maximum 80 characters. Describe what the skill does, \
not how. Imperative or noun phrase, e.g. "File a Notion bug ticket with team \
routing" or "Redaction rules for customer data and credentials".`;

/**
 * Summarizes a skill into a short one-line description suitable for the
 * CLAUDE.md skills index. Returns `null` on any failure path so callers can
 * keep the DB column NULL and fall back to name-only rendering.
 */
export async function summarizeSkill(filename: string, content: string): Promise<string | null> {
  // Cap the content we send. Skills can run thousands of tokens; the first
  // ~6KB is plenty to summarize the intent and saves token cost on long ones.
  const truncated = content.length > 6_000 ? content.slice(0, 6_000) + '\n\n…[truncated]' : content;
  const prompt = `Filename: ${filename}\n\n---\n\n${truncated}`;

  try {
    let text = '';
    for await (const msg of query({
      prompt,
      options: {
        model: MODEL,
        permissionMode: 'bypassPermissions',
        allowedTools: [],
        maxTurns: 1,
        systemPrompt: SYSTEM_PROMPT,
      },
    })) {
      const m = msg as { type: string; message?: { content?: unknown[] }; result?: string };
      if (m.type === 'assistant' && m.message?.content) {
        for (const part of m.message.content as { type: string; text?: string }[]) {
          if (part.type === 'text' && part.text) text += part.text;
        }
      } else if (m.type === 'result' && m.result) {
        text = m.result;
      }
    }

    return cleanDescription(text);
  } catch (err) {
    logger.warn('summarizeSkill failed', {
      filename,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Trims whitespace, strips wrapping quotes, drops trailing period, collapses
 * internal whitespace, and clamps to MAX_CHARS. Public for tests.
 */
export function cleanDescription(raw: string): string | null {
  let s = raw.trim().replace(/\s+/g, ' ');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS - 1).trimEnd() + '…';
  return s.length > 0 ? s : null;
}
