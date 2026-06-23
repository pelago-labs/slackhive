/**
 * @fileoverview Pure translation between Codex SDK events and the neutral
 * `BackendMessage` shape MessageHandler consumes. Extracted from the backend so
 * the mapping (the one place where Codex field names matter) is unit-testable.
 *
 * @module runner/backends/codex-translate
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Input, ThreadEvent, ThreadItem, Usage, UserInput } from '@openai/codex-sdk';
import type { BackendMessage, BackendUsage, AgentPrompt } from '@slackhive/shared';

const execFileAsync = promisify(execFile);

/** Cap pages rendered from a PDF — each page is a vision image (token cost), so
 *  bound it; the prompt notes when a longer PDF was truncated. */
const MAX_PDF_PAGES = 20;

/**
 * Codex's input is text + images only (no document/PDF type), so a PDF can't be
 * passed natively. Rasterize each page to a PNG with poppler's `pdftoppm` and feed
 * them as `local_image` entries — Codex reads them via its vision tool, preserving
 * layout/tables/scans. Returns the page-image paths in order (empty on failure).
 */
async function renderPdfToImages(pdfBuffer: Buffer, outDir: string, idx: number): Promise<string[]> {
  const pdfPath = path.join(outDir, `input-pdf-${idx}.pdf`);
  fs.writeFileSync(pdfPath, pdfBuffer);
  const prefix = path.join(outDir, `input-pdf-${idx}-page`);
  // -scale-to 2048 caps the long edge (legible text, bounded upload); -l limits pages.
  await execFileAsync('pdftoppm', ['-png', '-scale-to', '2048', '-l', String(MAX_PDF_PAGES), pdfPath, prefix], { timeout: 120_000 });
  const base = path.basename(prefix);
  return fs.readdirSync(outDir)
    .filter((f) => f.startsWith(base) && f.endsWith('.png'))
    .sort((a, b) => (parseInt(a.match(/-(\d+)\.png$/)?.[1] ?? '0', 10)) - (parseInt(b.match(/-(\d+)\.png$/)?.[1] ?? '0', 10)))
    .map((f) => path.join(outDir, f));
}

function assistant(content: Array<Record<string, unknown>>): BackendMessage {
  return { type: 'assistant', message: { role: 'assistant', content: content as never } };
}

function userResult(toolUseId: string, content: string, isError: boolean): BackendMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  };
}

/** Map Codex `Usage` onto the `ActivityUsageInput` shape `recordActivityUsage` expects. */
export function mapUsage(u: Usage | null | undefined): BackendUsage {
  if (!u) return {};
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
    cache_read_input_tokens: u.cached_input_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

/** Extract text from an MCP tool result's content blocks. */
function mcpResultText(result: { content: Array<{ type: string; text?: string }> } | undefined): string {
  if (!result?.content) return '';
  return result.content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('').trim();
}

/** Translate a completed thread item into assistant/user BackendMessages. */
export function translateItem(item: ThreadItem, finalParts: string[]): BackendMessage[] {
  switch (item.type) {
    case 'agent_message':
      // Only the LAST agent_message is the turn's deliverable; earlier ones are
      // progress preambles Codex emits as it works. They're streamed live in
      // verbose mode (each agent_message → an assistant text block below), but
      // must NOT leak into the non-verbose final result — otherwise "verbose off"
      // still posts all the narration. Mirror the SDK's own `finalResponse`, which
      // keeps only the last agent_message: reset rather than accumulate.
      finalParts.length = 0;
      finalParts.push(item.text);
      return [assistant([{ type: 'text', text: item.text }])];

    case 'reasoning':
      // Codex reasoning is verbose narration. Drop it from the stream so verbose
      // mode posts only tool activity + the actual answer (Claude-like). It's
      // still logged at DEBUG in CodexBackend's event loop for inspection.
      return [];

    case 'command_execution':
      return [
        assistant([{ type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command } }]),
        userResult(item.id, item.aggregated_output ?? '', (item.exit_code ?? 0) !== 0),
      ];

    case 'mcp_tool_call':
      return [
        assistant([{ type: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments }]),
        userResult(item.id, item.error ? item.error.message : mcpResultText(item.result), !!item.error),
      ];

    case 'file_change': {
      const summary = item.changes.map((c) => `${c.kind} ${c.path}`).join('\n');
      return [
        assistant([{ type: 'tool_use', id: item.id, name: 'Edit', input: { changes: item.changes } }]),
        userResult(item.id, summary || 'applied', item.status === 'failed'),
      ];
    }

    case 'web_search':
      return [
        assistant([{ type: 'tool_use', id: item.id, name: 'WebSearch', input: { query: item.query } }]),
        userResult(item.id, `Searched: ${item.query}`, false),
      ];

    case 'todo_list':
      // Plan/todo narration is not posted (same rationale as `reasoning`).
      return [];

    case 'error':
      return [assistant([{ type: 'text', text: item.message }])];

    default:
      return [];
  }
}

/** Translate one Codex ThreadEvent into zero or more neutral BackendMessages. */
export function translateEvent(event: ThreadEvent, finalParts: string[]): BackendMessage[] {
  switch (event.type) {
    case 'thread.started':
      return [{ type: 'system', subtype: 'init', session_id: event.thread_id }];

    case 'item.completed':
      return translateItem(event.item, finalParts);

    case 'turn.completed':
      return [{
        type: 'result',
        subtype: 'success',
        result: finalParts.join('\n\n').trim(),
        num_turns: 1,
        usage: mapUsage(event.usage),
        total_cost_usd: 0, // flat-rate on subscription; token-price estimate is a future refinement
      }];

    case 'turn.failed':
      return [{ type: 'result', subtype: 'error', result: event.error?.message ?? 'Codex turn failed' }];

    case 'error':
      return [{ type: 'result', subtype: 'error', result: event.message ?? 'Codex stream error' }];

    default:
      return []; // turn.started / item.started / item.updated — no-op
  }
}

/** Convert a SlackHive prompt (string or Claude-style content blocks) into Codex Input.
 *  Async because PDFs (Claude-style `document` blocks) are rasterized to page images —
 *  Codex has no native PDF input, so we feed the pages through its vision path. */
export async function toCodexInput(prompt: AgentPrompt, tmpDir: string): Promise<Input> {
  if (typeof prompt === 'string') return prompt;
  const out: UserInput[] = [];
  let imgIdx = 0;
  let pdfIdx = 0;
  for (const block of prompt as Array<Record<string, unknown>>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (block?.type === 'image') {
      const source = block.source as { data?: string; media_type?: string } | undefined;
      if (source?.data) {
        const ext = source.media_type?.split('/')[1] || 'png';
        const p = path.join(tmpDir, `input-image-${imgIdx++}.${ext}`);
        try {
          fs.writeFileSync(p, Buffer.from(source.data, 'base64'));
          out.push({ type: 'local_image', path: p });
        } catch { /* skip unreadable image */ }
      }
    } else if (block?.type === 'document') {
      // A PDF (message-handler emits a Claude `document` block). Codex can't take it
      // directly, so rasterize the pages and pass them as images.
      const source = block.source as { data?: string; media_type?: string } | undefined;
      if (source?.data && source.media_type === 'application/pdf') {
        try {
          const pages = await renderPdfToImages(Buffer.from(source.data, 'base64'), tmpDir, pdfIdx++);
          if (pages.length > 0) {
            const truncated = pages.length >= MAX_PDF_PAGES;
            out.push({ type: 'text', text: `[Attached PDF rendered as ${pages.length} page image${pages.length > 1 ? 's' : ''} below${truncated ? ` — only the first ${MAX_PDF_PAGES} pages` : ''}. Read them as the document's pages, in order.]` });
            for (const p of pages) out.push({ type: 'local_image', path: p });
          }
        } catch { /* skip unreadable / unrenderable pdf */ }
      }
    }
  }
  if (out.length === 0) return '';
  if (out.length === 1 && out[0].type === 'text') return out[0].text;
  return out;
}
