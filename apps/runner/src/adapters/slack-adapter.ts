/**
 * @fileoverview Slack platform adapter implementing PlatformAdapter.
 *
 * Wraps @slack/bolt App and extracts all Slack-specific logic:
 * - Socket Mode connection lifecycle
 * - mrkdwn formatting (markdown → Slack)
 * - Block Kit payloads (tables, sections)
 * - File download with Bearer auth
 * - Reactions, threading, mention stripping
 * - Formatting rules for CLAUDE.md injection
 *
 * The brain (ClaudeHandler) and message flow (MessageHandler) never
 * import @slack/bolt — they talk only through PlatformAdapter interface.
 *
 * @module runner/adapters/slack-adapter
 */

import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type {
  PlatformAdapter, IncomingMessage, ThreadMessage, FileAttachment, MessagePayload,
  SlackCredentials,
} from '@slackhive/shared';
import { agentLogger } from '../logger';
import type { Logger } from 'winston';

// =============================================================================
// Constants
// =============================================================================

const MAX_THREAD_CONTEXT_MESSAGES = 20;
const MAX_THREAD_CONTEXT_CHARS = 8_000;
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_BINARY_FILE_BYTES = 20 * 1024 * 1024;

const TEXT_MIMETYPES = new Set([
  'text/plain', 'text/csv', 'text/html', 'text/xml', 'text/markdown',
  'text/x-python', 'text/x-script.python', 'text/javascript',
  'application/json', 'application/xml', 'application/x-yaml',
  'application/x-ndjson', 'application/sql',
]);

const TEXT_FILETYPES = new Set([
  'text', 'csv', 'json', 'yaml', 'xml', 'html', 'markdown', 'md',
  'python', 'py', 'javascript', 'js', 'typescript', 'ts', 'go',
  'ruby', 'rb', 'java', 'kotlin', 'swift', 'cpp', 'c', 'rust',
  'sh', 'bash', 'zsh', 'sql', 'r', 'scala', 'php', 'toml', 'ini',
  'conf', 'cfg', 'env', 'diff', 'patch', 'log',
]);

const IMAGE_MIMETYPES: Record<string, string> = {
  'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg',
  'image/png': 'image/png', 'image/webp': 'image/webp',
};

const IMAGE_FILETYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

/** Friendly labels shown while MCP tools run. */
const MCP_TOOL_LABELS: Record<string, string> = {
  'mcp__redshift-mcp__query': 'Querying Redshift',
  'mcp__redshift-mcp__describe_table': 'Inspecting table structure',
  'mcp__redshift-mcp__find_column': 'Searching for columns',
};

// =============================================================================
// SlackAdapter
// =============================================================================

export class SlackAdapter implements PlatformAdapter {
  readonly platform = 'slack';

  private app!: App;
  private log: Logger;
  private botUserId?: string;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private credentials: SlackCredentials;

  constructor(credentials: SlackCredentials, agentSlug: string) {
    this.credentials = credentials;
    this.log = agentLogger(agentSlug);
    // Don't construct Bolt's App here — it spins up a SocketModeReceiver
    // that eagerly validates tokens in the background and orphans any
    // resulting rejection. Build it in start() AFTER the credential probe
    // passes so a bad-token agent never creates socket machinery.
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Pre-flight credential check using a standalone WebClient (NOT
    // `this.app.client`). Bolt's own WebClient sits behind retry + rate-limit
    // middleware that orphans the rejection on failure, producing a stray
    // `unhandledRejection` even when we await and catch here.
    //
    // If the botToken is invalid we must bail before `app.start()` opens the
    // Socket Mode connection — that uses only the appToken and "succeeds"
    // with a garbage botToken, leaving the agent visibly "running" but
    // unable to post anything.
    try {
      const probe = new WebClient(this.credentials.botToken);
      const auth = await probe.auth.test();
      this.botUserId = auth.user_id as string;
    } catch (err) {
      const raw = (err as Error).message;
      const friendly = /invalid_auth|not_authed|token_revoked/i.test(raw)
        ? 'Slack bot token is invalid or revoked. Paste fresh bot and app tokens in Settings → Platform Integrations.'
        : /missing_scope/i.test(raw)
          ? 'Slack app is missing required OAuth scopes. Reinstall the app with the scopes listed in Settings.'
          : `Slack auth failed: ${raw}`;
      this.log.warn('Slack credential probe failed', { error: raw });
      throw new Error(friendly);
    }

    // Probe passed — build the real App now. Events registered below will be
    // bound to this instance before start() opens the socket.
    this.app = new App({
      token: this.credentials.botToken,
      appToken: this.credentials.appToken,
      signingSecret: this.credentials.signingSecret,
      socketMode: true,
      logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.WARN,
    });

    // Register Slack event handlers
    this.app.event('app_mention', async ({ event, client }) => {
      if (!this.messageHandler) return;
      await this.messageHandler({
        id: event.ts,
        platform: 'slack',
        userId: event.user ?? 'unknown',
        channelId: event.channel,
        threadId: event.thread_ts ?? event.ts,
        text: this.stripMention(event.text ?? ''),
        isDM: false,
        files: this.mapFiles((event as any).files),
        raw: { client, messageTs: event.ts },
      });
    });

    this.app.message(async ({ message, client }) => {
      const msg = message as any;
      if (!msg.channel?.startsWith('D') || !msg.user) return;
      if (!this.messageHandler) return;
      await this.messageHandler({
        id: msg.ts,
        platform: 'slack',
        userId: msg.user,
        channelId: msg.channel,
        threadId: msg.thread_ts,
        text: this.stripMention(msg.text ?? ''),
        isDM: true,
        files: this.mapFiles(msg.files),
        raw: { client, messageTs: msg.ts },
      });
    });

    this.app.event('member_joined_channel', async ({ event, client }) => {
      if (!this.botUserId || event.user !== this.botUserId) return;
      try {
        await client.chat.postMessage({
          channel: event.channel,
          text: `Hi! Mention me to get started.`,
        });
      } catch { /* non-fatal */ }
    });

    await this.app.start();
    this.log.info('Slack adapter started', { botUserId: this.botUserId });
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  getBotUserId(): string | undefined {
    return this.botUserId;
  }

  /** Expose the Bolt App for backward compatibility during migration. */
  getApp(): App {
    return this.app;
  }

  // ─── Receive ───────────────────────────────────────────────────────

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // ─── Send ──────────────────────────────────────────────────────────

  async postMessage(channelId: string, text: string, threadId?: string): Promise<string> {
    const client = this.app.client;
    try {
      const payloads = this.buildPayloads(text);
      let lastTs = '';
      for (const payload of payloads) {
        const opts: any = {
          channel: channelId,
          text: payload.text,
          ...(threadId && { thread_ts: threadId }),
          ...(payload.blocks && { blocks: payload.blocks }),
        };
        try {
          const result = await client.chat.postMessage(opts);
          lastTs = result.ts as string;
        } catch (err: any) {
          if (err?.data?.error === 'invalid_blocks' && payload.blocks) {
            const result = await client.chat.postMessage({
              channel: channelId, text: payload.text, ...(threadId && { thread_ts: threadId }),
            });
            lastTs = result.ts as string;
          } else {
            throw err;
          }
        }
      }
      return lastTs;
    } catch (err) {
      this.log.error('Failed to post message', { error: err });
      throw err;
    }
  }

  async postPayload(channelId: string, payload: MessagePayload, threadId?: string): Promise<string> {
    const opts: any = {
      channel: channelId,
      text: payload.text,
      ...(threadId && { thread_ts: threadId }),
      ...(payload.blocks && { blocks: payload.blocks }),
    };
    try {
      const result = await this.app.client.chat.postMessage(opts);
      return result.ts as string;
    } catch (err: any) {
      if (err?.data?.error === 'invalid_blocks' && payload.blocks) {
        const result = await this.app.client.chat.postMessage({
          channel: channelId, text: payload.text, ...(threadId && { thread_ts: threadId }),
        });
        return result.ts as string;
      }
      throw err;
    }
  }

  async updateMessage(channelId: string, messageId: string, text: string): Promise<void> {
    await this.app.client.chat.update({ channel: channelId, ts: messageId, text });
  }

  async postReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.add({ channel: channelId, timestamp: messageId, name: emoji });
    } catch { /* non-fatal */ }
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.remove({ channel: channelId, timestamp: messageId, name: emoji });
    } catch { /* non-fatal */ }
  }

  async uploadFile(channelId: string, content: string | Buffer, filename: string, threadId?: string): Promise<void> {
    const opts: any = {
      channel_id: channelId,
      content: typeof content === 'string' ? content : content.toString('utf-8'),
      filename,
    };
    if (threadId) opts.thread_ts = threadId;
    await this.app.client.filesUploadV2(opts);
  }

  // ─── Context ───────────────────────────────────────────────────────

  async getThreadMessages(channelId: string, threadId: string, limit: number): Promise<ThreadMessage[]> {
    try {
      const replies = await this.app.client.conversations.replies({
        channel: channelId, ts: threadId, limit: Math.min(limit, MAX_THREAD_CONTEXT_MESSAGES),
      });
      const messages: any[] = replies.messages ?? [];
      // Exclude the last message (it's the one being replied to)
      return messages.slice(0, -1).map(m => ({
        userId: m.user ?? '',
        text: this.stripMention(m.text ?? ''),
        isBot: !!m.bot_id,
        displayName: undefined,
        files: this.mapFiles(m.files),
      }));
    } catch {
      return [];
    }
  }

  async getUserDisplayName(userId: string): Promise<string> {
    try {
      const info = await this.app.client.users.info({ user: userId });
      return (info.user as any)?.display_name || info.user?.real_name || userId;
    } catch {
      return userId;
    }
  }

  async openDm(userId: string): Promise<string> {
    const result = await this.app.client.conversations.open({ users: userId });
    return result.channel?.id ?? '';
  }

  // ─── Formatting ────────────────────────────────────────────────────

  getFormattingRules(): string {
    return `# Slack Formatting

You are responding in Slack. Follow these rules for every message:

**Text formatting:**
- Bold: \`*bold*\` — NOT \`**bold**\`
- Italic: \`_italic_\` — NOT \`*italic*\`
- Section headers: \`*Header Text*\` on its own line — NOT \`#\`, \`##\`, \`###\`
- Inline code: \`` + '`' + `code\`` + '`' + `
- Code blocks: triple backticks with language hint (\`\`\`sql ... \`\`\`)
- Lists: \`- item\` or \`1. item\`
- Links: \`<url|text>\`
- Horizontal rules: just a blank line — NOT \`---\` or \`***\`
- Blockquotes: use plain text or \`_italic_\` — NOT \`>\`

**Tables — use standard Markdown pipe format:**
- Every row MUST start and end with \`|\`
- Always include a separator row: \`|---|---|---|\`
- Do NOT wrap tables in code blocks

Good:
\`\`\`
| Name | Count |
|---|---|
| Alpha | 42 |
\`\`\`

**Never use:** \`## headings\`, \`**double asterisks**\`, \`> blockquotes\`, \`---\` rules`;
  }

  formatMarkdown(md: string): string {
    const codeBlocks: string[] = [];
    let formatted = md.replace(/```[\s\S]*?```/g, (match) => {
      codeBlocks.push(match);
      return `\x00CB${codeBlocks.length - 1}\x00`;
    });

    // Auto-wrap bare markdown tables in code blocks
    formatted = formatted.replace(
      /(?:^|\n)((?:[ \t]*\S.+\|.+[ \t]*\n?){2,})/g,
      (_match, tableBlock) => `\n\`\`\`\n${tableBlock.trim()}\n\`\`\`\n`
    );

    formatted = formatted.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
    formatted = formatted.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '');
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '*$1*');
    formatted = formatted.replace(/__([^_]+)__/g, '_$1_');

    formatted = formatted.replace(/\x00CB(\d+)\x00/g, (_, index) => {
      const block = codeBlocks[parseInt(index)];
      return block.replace(/^```\w+\n/, '```\n');
    });

    return formatted;
  }

  buildPayloads(text: string, isFinal?: boolean): MessagePayload[] {
    const payloads: MessagePayload[] = [];
    let remaining = text;

    while (remaining.trim()) {
      const extracted = extractFirstMarkdownTable(remaining);

      if (!extracted) {
        payloads.push({ text: this.formatMarkdown(remaining) });
        break;
      }

      const parsed = parseMarkdownTable(extracted.tableLines);
      if (parsed.headers.length === 0) {
        payloads.push({ text: this.formatMarkdown(remaining) });
        break;
      }

      const blocks: any[] = [];
      const beforeText = this.formatMarkdown(extracted.before.trim());
      if (beforeText) {
        for (const chunk of splitTextForBlocks(beforeText)) {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
        }
      }
      blocks.push(buildSlackTableBlock(parsed));

      const fallback = this.formatMarkdown(
        extracted.before.trim() + '\n' + extracted.tableLines.join('\n'),
      );
      payloads.push({ text: fallback, blocks });

      remaining = extracted.after;
    }

    return payloads.length > 0 ? payloads : [{ text: this.formatMarkdown(text) }];
  }

  // ─── Platform-specific ─────────────────────────────────────────────

  async leaveChannel(channelId: string): Promise<void> {
    await this.app.client.conversations.leave({ channel: channelId });
  }

  formatMention(userId: string): string {
    return `<@${userId}>`;
  }

  stripMention(text: string): string {
    if (!this.botUserId) return text;
    return text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
  }

  /** Slack mention form: `<@U...>`. Returns the bare IDs. */
  parseMentions(text: string): string[] {
    const out: string[] = [];
    const re = /<@([UW][A-Z0-9]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  async downloadFile(url: string): Promise<Buffer> {
    const token: string = (this.app.client as any).token ?? '';
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  // ─── Tool status formatting ────────────────────────────────────────

  /** Format a tool_use block into a status string for the status message. */
  formatToolStatus(content: any[]): string | null {
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const label = MCP_TOOL_LABELS[block.name];
      if (label) {
        if (block.name === 'mcp__redshift-mcp__query' && block.input?.sql) {
          return `*${label}*\n\`\`\`sql\n${String(block.input.sql).slice(0, 500)}\n\`\`\``;
        }
        if (block.input?.query) return `*${label}:* \`${String(block.input.query).slice(0, 100)}\``;
        if (block.input?.fqn || block.input?.name) return `*${label}:* \`${block.input.fqn ?? block.input.name}\``;
        return `*${label}...*`;
      }
      return `*Working...*`;
    }
    return null;
  }

  // ─── File helpers ──────────────────────────────────────────────────

  getFileKind(file: FileAttachment): 'text' | 'image' | 'pdf' | 'unsupported' {
    const mt = file.mimeType ?? '';
    const ft = (file.fileType ?? '').toLowerCase();
    if (mt === 'application/pdf' || ft === 'pdf') return 'pdf';
    if (mt in IMAGE_MIMETYPES || ft in IMAGE_FILETYPES) return 'image';
    if (TEXT_MIMETYPES.has(mt) || mt.startsWith('text/') || TEXT_FILETYPES.has(ft)) return 'text';
    return 'unsupported';
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private mapFiles(files?: any[]): FileAttachment[] | undefined {
    if (!files || files.length === 0) return undefined;
    return files.map(f => ({
      id: f.id,
      name: f.name ?? f.title ?? f.id,
      mimeType: f.mimetype,
      fileType: f.filetype,
      size: f.size,
      url: f.url_private_download,
    }));
  }
}

// =============================================================================
// Table helpers (Slack Block Kit specific)
// =============================================================================

function isSeparatorLine(line: string): boolean {
  return /^\s*\|?[-:\s|]+\|?\s*$/.test(line) && line.includes('-');
}

function extractFirstMarkdownTable(text: string): { before: string; tableLines: string[]; after: string } | null {
  const codeBlockTableRe = /```(?:\w*)\n((?:[ \t]*.+\|.+[ \t]*\n?){2,})```/;
  const bareTableRe = /(?:^|\n)((?:[ \t]*\|.+\|[ \t]*(?:\n|$)){2,})/;
  const loosePipeRe = /(?:^|\n)((?:[ \t]*\S.+\|.+(?:\n|$)){2,})/;

  const candidates: { match: RegExpExecArray; content: string }[] = [];
  const cbMatch = codeBlockTableRe.exec(text);
  const bareMatch = bareTableRe.exec(text);
  const looseMatch = loosePipeRe.exec(text);
  if (cbMatch) candidates.push({ match: cbMatch, content: cbMatch[1] });
  if (bareMatch) candidates.push({ match: bareMatch, content: bareMatch[1] });
  if (looseMatch) candidates.push({ match: looseMatch, content: looseMatch[1] });
  candidates.sort((a, b) => a.match.index - b.match.index);

  for (const { match, content } of candidates) {
    const lines = content.trim().split('\n').map(l => l.trim());
    if (lines.length < 2) continue;
    if (!lines.some(l => isSeparatorLine(l))) continue;
    const fullMatch = match[0];
    const startIdx = match.index + (fullMatch.startsWith('\n') ? 1 : 0);
    const endIdx = match.index + fullMatch.length;
    return { before: text.slice(0, startIdx), tableLines: lines, after: text.slice(endIdx) };
  }
  return null;
}

function parseMarkdownTable(lines: string[]): { headers: string[]; rows: string[][]; alignments: ('left' | 'center' | 'right')[] } {
  const splitRow = (line: string): string[] =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const headers = splitRow(lines[0]);
  const sepIdx = lines.findIndex(l => isSeparatorLine(l));
  const sepCells = sepIdx >= 0 ? splitRow(lines[sepIdx]) : [];
  const alignments: ('left' | 'center' | 'right')[] = sepCells.map(cell => {
    const t = cell.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    return 'left';
  });
  while (alignments.length < headers.length) alignments.push('left');
  const rows: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 || i === sepIdx) continue;
    rows.push(splitRow(lines[i]));
  }
  return { headers, rows, alignments };
}

function buildSlackTableBlock(parsed: { headers: string[]; rows: string[][]; alignments: ('left' | 'center' | 'right')[] }): Record<string, any> {
  const maxCols = Math.min(parsed.headers.length, 20);
  const buildRow = (cells: string[]) =>
    Array.from({ length: maxCols }, (_, i) => ({ type: 'raw_text', text: (cells[i] || '').toString() }));
  return {
    type: 'table',
    rows: [buildRow(parsed.headers), ...parsed.rows.slice(0, 99).map(r => buildRow(r))],
    column_settings: parsed.alignments.slice(0, maxCols).map(a => ({ align: a })),
  };
}

function splitTextForBlocks(text: string): string[] {
  const MAX = 3000;
  if (text.length <= MAX) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', MAX);
    if (splitAt <= 0) splitAt = MAX;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}
