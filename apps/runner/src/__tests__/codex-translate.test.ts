import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

describe('codex-translate / toCodexInput — PDF staged to disk', () => {
  const pdfData = Buffer.from('%PDF-1.4 fake').toString('base64');
  const pdfBlock = { type: 'document', source: { media_type: 'application/pdf', data: pdfData } };
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pdf-')); });

  it('stages the PDF to ./attachments/ and emits a pdftotext guidance note', async () => {
    const out = await toCodexInput([{ type: 'text', text: 'summarize' }, pdfBlock], dir) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ type: 'text', text: 'summarize' });
    expect(out[1].type).toBe('text');
    expect(String(out[1].text)).toContain('attachment-0.pdf');
    expect(String(out[1].text)).toContain('pdftotext');
    // File actually written to disk
    expect(fs.existsSync(path.join(dir, 'attachments', 'attachment-0.pdf'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'attachments', 'attachment-0.pdf'))).toEqual(Buffer.from(pdfData, 'base64'));
  });

  it('stages two PDFs in the same turn with distinct names', async () => {
    await toCodexInput([pdfBlock, pdfBlock], dir);
    const files = fs.readdirSync(path.join(dir, 'attachments')).sort();
    expect(files).toEqual(['attachment-0.pdf', 'attachment-1.pdf']);
  });

  it('does not produce local_image blocks for PDFs', async () => {
    const out = await toCodexInput([pdfBlock], dir);
    // single PDF → collapses to a plain string (the guidance note), no images
    expect(typeof out === 'string' || (Array.isArray(out) && out.every((o: unknown) => (o as Record<string, unknown>).type !== 'local_image'))).toBe(true);
  });

  it('surfaces a note (not silence) when staging fails', async () => {
    // Pass a read-only dir so mkdirSync/writeFileSync throws
    const roDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
    fs.chmodSync(roDir, 0o555);
    const out = await toCodexInput([pdfBlock], roDir);
    const text = typeof out === 'string' ? out : (out as Array<Record<string, unknown>>).map(o => String(o.text)).join(' ');
    expect(text).toMatch(/could not be saved/i);
    fs.chmodSync(roDir, 0o755); // restore for cleanup
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
