/**
 * @fileoverview Tests for redactTurn (the non-admin server-side trace redaction).
 * Locks in two code-review fixes:
 *  - #1: redaction runs at level 'all', so heuristic high-entropy VALUES are masked
 *        (level 'pii' excluded them, leaking opaque tokens to non-admins).
 *  - #2: statusMessage (tool error text) is redacted too, not just input/output/reasoning.
 *
 * @module web/lib/__tests__/redact-turn
 */
import { describe, expect, it } from 'vitest';
import { redactTurn } from '@/lib/activity-redact';
import type { TraceTurn, TraceSpan } from '@slackhive/shared';

function span(over: Partial<TraceSpan>): TraceSpan {
  return {
    spanId: 's1', parentSpanId: null, kind: 'tool', name: 't', model: null, provider: null,
    startMs: 0, endMs: 1, durationMs: 1, status: 'ok', statusMessage: null, toolName: 't',
    inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null,
    cacheCreationTokens: null, costUsd: null, finishReason: null,
    input: null, output: null, reasoning: null,
    sensitive: false, sensitiveCategories: [], sensitiveReason: null, sensitiveSeverity: null,
    sensitiveLlm: false, sensitiveLlmHits: [],
    ...over,
  };
}
function turn(spans: TraceSpan[], finalAnswer: string | null = null): TraceTurn {
  return {
    activityId: 'a1', agentId: 'ag', agentName: 'Ag', agentSlug: 'ag', status: 'done',
    startedAt: '2026-01-01 00:00:00', finishedAt: '2026-01-01 00:00:01', messagePreview: null,
    error: null, initiatorKind: 'user', initiatorHandle: null,
    delegatedByAgentName: null, delegatedByAgentSlug: null, durationMs: 1,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, finalAnswer, sensitive: false, sensitiveCategories: [], feedback: [], spans,
  };
}

describe('redactTurn — non-admin server redaction', () => {
  it('#1 masks heuristic high-entropy values (level "all"), not leaks them', () => {
    const tok = 'aA1' + 'bC2dE3fG4hI5jK6lM7nO8pQ9rS0'.repeat(2); // 40+ char high-entropy
    const out = redactTurn(turn([span({ output: `token ${tok} end` })]));
    expect(out.spans[0].output).not.toContain(tok);
    expect(out.spans[0].output).toContain('[redacted:');
  });

  it('#2 redacts statusMessage (tool error text), not only input/output/reasoning', () => {
    const out = redactTurn(turn([span({
      status: 'error',
      statusMessage: 'connect failed for bob@acme.com using sk-ABCDEFGHIJKLMNOPQRSTUV',
    })]));
    expect(out.spans[0].statusMessage).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV');
    expect(out.spans[0].statusMessage).not.toContain('bob@acme.com');
  });

  it('#2 strips LLM-detector excerpts from statusMessage as well', () => {
    const out = redactTurn(turn([span({
      status: 'error',
      statusMessage: 'failed: five five five oh one two six',
      sensitiveLlmHits: [{ text: 'five five five oh one two six', category: 'pii', label: 'pii:phone', severity: 'medium' }],
    })]));
    expect(out.spans[0].statusMessage).not.toContain('five five five oh one two six');
    expect(out.spans[0].sensitiveLlmHits).toEqual([]);
  });

  it('masks values in the final answer too', () => {
    const out = redactTurn(turn([span({})], 'here is sk-ABCDEFGHIJKLMNOPQRSTUV'));
    expect(out.finalAnswer).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV');
  });
});
