import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ThreadEvent } from '@openai/codex-sdk';
import { translateEvent, mapUsage, toCodexInput } from '../backends/codex-translate';

// Stub poppler's `pdftoppm`: instead of rasterizing, fabricate <prefix>-N.png pages
// so the PDF→images path is testable deterministically without the binary.
const pdf = vi.hoisted(() => ({ pages: 3 }));
vi.mock('child_process', () => ({
  execFile: (_file: string, args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
    const realFs = require('fs');
    const prefix = args[args.length - 1]; // pdftoppm's output prefix is the last arg
    for (let i = 1; i <= pdf.pages; i++) realFs.writeFileSync(`${prefix}-${i}.png`, 'x');
    cb(null, { stdout: '', stderr: '' });
  },
}));

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
  it('passes through plain strings', async () => {
    expect(await toCodexInput('hello', '/tmp')).toBe('hello');
  });
  it('collapses a single text block to a string', async () => {
    expect(await toCodexInput([{ type: 'text', text: 'hi' }], '/tmp')).toBe('hi');
  });
  it('drops unsupported blocks (e.g. a non-pdf document) rather than crashing', async () => {
    expect(await toCodexInput([{ type: 'document', source: { media_type: 'text/csv', data: 'x' } }], '/tmp')).toBe('');
  });
});

describe('codex-translate / toCodexInput — PDF rendered to page images', () => {
  const pdfBlock = { type: 'document', source: { media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 fake').toString('base64') } };
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pdf-')); });

  it('renders a PDF to ordered page images preceded by a guidance note', async () => {
    pdf.pages = 3;
    const out = await toCodexInput([{ type: 'text', text: 'summarize' }, pdfBlock], dir) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ type: 'text', text: 'summarize' });
    expect(out[1].type).toBe('text');
    expect(out[1].text).toContain('3 page images');
    const imgs = out.filter(o => o.type === 'local_image').map(o => path.basename(o.path as string));
    expect(imgs).toEqual(['input-pdf-0-page-1.png', 'input-pdf-0-page-2.png', 'input-pdf-0-page-3.png']);
  });

  it('flags truncation when the PDF exceeds the 20-page cap', async () => {
    pdf.pages = 20;
    const out = await toCodexInput([pdfBlock], dir) as Array<Record<string, unknown>>;
    const note = out.find(o => o.type === 'text') as { text: string };
    expect(note.text).toContain('only the first 20 pages');
    expect(out.filter(o => o.type === 'local_image')).toHaveLength(20);
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

    // reasoning is dropped entirely (not posted) — no thinking message emitted.
    expect(out.some((m) => (m as any).message?.content?.[0]?.type === 'thinking')).toBe(false);

    // command_execution → tool_use (Bash) + tool_result (not error)
    expect((out[1] as any).message.content[0]).toMatchObject({ type: 'tool_use', name: 'Bash', id: 'c1', input: { command: 'ls' } });
    expect((out[2] as any).message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: false, content: 'file.txt' });

    // agent_message → assistant text, accumulated into final result
    expect((out[3] as any).message.content[0]).toMatchObject({ type: 'text', text: 'Done.' });

    // turn.completed → result with mapped usage + accumulated final text
    const result = out[4] as any;
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

  it('keeps only the last agent_message in the final result (preambles are verbose-only)', () => {
    const finalParts: string[] = [];
    const events: ThreadEvent[] = [
      { type: 'item.completed', item: { id: 'p1', type: 'agent_message', text: 'Let me check the table grain first.' } },
      { type: 'item.completed', item: { id: 't1', type: 'mcp_tool_call', server: 'redshift', tool: 'query', arguments: {}, result: { content: [{ type: 'text', text: 'ok' }], structured_content: null }, status: 'completed' } },
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'There are 42 customers.' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ] as ThreadEvent[];
    const out = events.flatMap((e) => translateEvent(e, finalParts));
    // Both agent_messages are still emitted as assistant blocks (verbose streams them live)...
    const texts = out.filter((m) => (m as any).type === 'assistant' && (m as any).message.content[0]?.type === 'text').map((m) => (m as any).message.content[0].text);
    expect(texts).toEqual(['Let me check the table grain first.', 'There are 42 customers.']);
    // ...but the non-verbose final result is ONLY the last one — no preamble.
    const result = out.find((m) => (m as any).type === 'result') as any;
    expect(result.result).toBe('There are 42 customers.');
  });
});
