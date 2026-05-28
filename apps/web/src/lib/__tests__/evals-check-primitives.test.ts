/**
 * @fileoverview Unit tests for evaluateStaticCheck — tool_called primitive.
 *
 * Covers the two behaviour changes in c0ec720:
 *   1. must_not_call should pass VACUOUSLY when the agent invoked no tools
 *      (was incorrectly FAIL-ing before).
 *   2. Trailing `*` in a tool id is a suffix wildcard — `mcp__github__*`
 *      matches any tool from the github MCP.
 *
 * @module web/lib/__tests__/evals-check-primitives.test
 */

import { describe, it, expect } from 'vitest';
import { evaluateStaticCheck } from '@/lib/evals/check-primitives';
import type { CheckConfig, ToolCallTrace } from '@slackhive/shared';
import type { Trace } from '@/lib/evals/run-case';

function trace(toolIds: string[] = [], finalReply = ''): Trace {
  return {
    finalReply,
    toolCalls: toolIds.map<ToolCallTrace>((toolId) => ({ toolId, input: {} })),
    errored: false,
  };
}

function toolCheck(parts: {
  must_call?: string[];
  must_not_call?: string[];
}): CheckConfig {
  return { primitive: 'tool_called', ...parts };
}

describe('checkToolCalled — empty toolCalls semantics', () => {
  it('PASSes when must_not_call is set and no tools were called (vacuously satisfied)', () => {
    // Regression: this used to FAIL with "Agent invoked no tools — nothing
    // to check." The case-level "static FAIL beats judge PASS" rule then
    // skipped the llm_judge, so the user got a misleading FAIL.
    const result = evaluateStaticCheck(
      toolCheck({ must_not_call: ['mcp__github__get_pull_request'] }),
      trace([]),
    );
    expect(result).toEqual({ primitive: 'tool_called', verdict: 'PASS' });
  });

  it('FAILs when must_call is set and no tools were called', () => {
    const result = evaluateStaticCheck(
      toolCheck({ must_call: ['mcp__redshift__query'] }),
      trace([]),
    );
    expect(result?.verdict).toBe('FAIL');
    expect(result?.message).toContain('mcp__redshift__query');
  });

  it('PASSes when both must_call and must_not_call are empty arrays (degenerate)', () => {
    const result = evaluateStaticCheck(
      toolCheck({ must_call: [], must_not_call: [] }),
      trace([]),
    );
    expect(result).toEqual({ primitive: 'tool_called', verdict: 'PASS' });
  });
});

describe('checkToolCalled — wildcard `*` suffix matching', () => {
  it('matches must_call wildcard against any tool from that MCP', () => {
    const result = evaluateStaticCheck(
      toolCheck({ must_call: ['mcp__github__*'] }),
      trace(['mcp__github__get_pull_request']),
    );
    expect(result?.verdict).toBe('PASS');
  });

  it('FAILs must_call wildcard when only a different MCP was called', () => {
    const result = evaluateStaticCheck(
      toolCheck({ must_call: ['mcp__github__*'] }),
      trace(['mcp__notion__search']),
    );
    expect(result?.verdict).toBe('FAIL');
    expect(result?.message).toContain('mcp__github__*');
  });

  it('FAILs must_not_call wildcard when ANY tool from that MCP was called', () => {
    const result = evaluateStaticCheck(
      toolCheck({ must_not_call: ['mcp__redshift__*'] }),
      trace(['mcp__redshift__query']),
    );
    expect(result?.verdict).toBe('FAIL');
    expect(result?.message).toContain('mcp__redshift__*');
  });

  it('PASSes must_not_call wildcard when only an unrelated MCP was called', () => {
    const result = evaluateStaticCheck(
      toolCheck({ must_not_call: ['mcp__redshift__*'] }),
      trace(['mcp__github__create_issue']),
    );
    expect(result?.verdict).toBe('PASS');
  });
});

describe('checkToolCalled — exact match still works alongside wildcards', () => {
  it('PASSes exact must_call when the tool was called', () => {
    const result = evaluateStaticCheck(
      toolCheck({ must_call: ['mcp__github__get_pull_request'] }),
      trace(['mcp__github__get_pull_request', 'mcp__notion__search']),
    );
    expect(result?.verdict).toBe('PASS');
  });

  it('FAILs exact must_call when only a different tool from the same MCP was called', () => {
    // Verifies that a missing exact tool id is reported even when other
    // tools from the same server ARE called — wildcards aren't applied
    // implicitly.
    const result = evaluateStaticCheck(
      toolCheck({ must_call: ['mcp__github__merge_pull_request'] }),
      trace(['mcp__github__get_pull_request']),
    );
    expect(result?.verdict).toBe('FAIL');
  });

  it('handles mixed must_call (exact) + must_not_call (wildcard) in one check', () => {
    const result = evaluateStaticCheck(
      toolCheck({
        must_call: ['mcp__github__get_pull_request'],
        must_not_call: ['mcp__redshift__*'],
      }),
      trace(['mcp__github__get_pull_request']),
    );
    expect(result?.verdict).toBe('PASS');
  });
});
