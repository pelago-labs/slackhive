import { describe, it, expect } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import { translateEvent, mapUsage, toCodexInput } from '../backends/codex-translate';

describe('codex-translate / mapUsage', () => {
  it('maps Codex usage onto the ActivityUsageInput shape', () => {
    expect(mapUsage({ input_tokens: 100, cached_input_tokens: 30, output_tokens: 50, reasoning_output_tokens: 20 }))
      .toEqual({ input_tokens: 100, output_tokens: 70, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 });
  });
  it('returns empty for null usage', () => {
    expect(mapUsage(null)).toEqual({});
  });
});

describe('codex-translate / toCodexInput', () => {
  it('passes through plain strings', () => {
    expect(toCodexInput('hello', '/tmp')).toBe('hello');
  });
  it('collapses a single text block to a string', () => {
    expect(toCodexInput([{ type: 'text', text: 'hi' }], '/tmp')).toBe('hi');
  });
});

describe('codex-translate / translateEvent', () => {
  it('maps a full turn (started → reasoning → command → message → completed)', () => {
    const finalParts: string[] = [];
    const events: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 'th_123' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking...' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'file.txt', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 2 } },
    ];

    const out = events.flatMap((e) => translateEvent(e, finalParts));

    // thread.started → system init with session_id
    expect(out[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'th_123' });

    // reasoning → assistant thinking
    expect(out[1]).toMatchObject({ type: 'assistant' });
    expect((out[1] as any).message.content[0]).toMatchObject({ type: 'thinking', thinking: 'thinking...' });

    // command_execution → tool_use (Bash) + tool_result (not error)
    expect((out[2] as any).message.content[0]).toMatchObject({ type: 'tool_use', name: 'Bash', id: 'c1', input: { command: 'ls' } });
    expect((out[3] as any).message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: false, content: 'file.txt' });

    // agent_message → assistant text, accumulated into final result
    expect((out[4] as any).message.content[0]).toMatchObject({ type: 'text', text: 'Done.' });

    // turn.completed → result with mapped usage + accumulated final text
    const result = out[5] as any;
    expect(result).toMatchObject({ type: 'result', subtype: 'success', result: 'Done.', num_turns: 1, total_cost_usd: 0 });
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  it('marks a failed command as an error tool_result', () => {
    const out = translateEvent(
      { type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'false', aggregated_output: 'boom', exit_code: 1, status: 'failed' } },
      [],
    );
    expect((out[1] as any).message.content[0]).toMatchObject({ type: 'tool_result', is_error: true });
  });

  it('maps an mcp_tool_call to a prefixed tool_use + result', () => {
    const out = translateEvent(
      { type: 'item.completed', item: { id: 't1', type: 'mcp_tool_call', server: 'github', tool: 'list_repos', arguments: { org: 'x' }, result: { content: [{ type: 'text', text: 'ok' }], structured_content: null }, status: 'completed' } },
      [],
    );
    expect((out[0] as any).message.content[0]).toMatchObject({ type: 'tool_use', name: 'mcp__github__list_repos' });
    expect((out[1] as any).message.content[0]).toMatchObject({ type: 'tool_result', content: 'ok', is_error: false });
  });

  it('maps a web_search item to a WebSearch tool_use', () => {
    const out = translateEvent(
      { type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'codex sdk' } },
      [],
    );
    expect((out[0] as any).message.content[0]).toMatchObject({ type: 'tool_use', name: 'WebSearch', input: { query: 'codex sdk' } });
  });

  it('maps turn.failed to an error result', () => {
    const out = translateEvent({ type: 'turn.failed', error: { message: 'rate limited' } }, []);
    expect(out[0]).toMatchObject({ type: 'result', subtype: 'error', result: 'rate limited' });
  });
});
