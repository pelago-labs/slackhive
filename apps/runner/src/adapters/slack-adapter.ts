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
import { recordMessageFeedback } from '@slackhive/shared';
import { agentLogger } from '../logger';
import { SLACK_FORMATTING_SECTION } from '../compile-claude-md';
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
        ? 'Slack bot token is invalid or revoked. Update the Bot Token in the agent\'s Slack Credentials section.'
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
      const ev = event as any;
      const { files: attFiles, text: attText } = this.extractFromAttachments(ev.attachments);
      const directFiles = this.mapFiles(ev.files) ?? [];
      const allFiles = [...directFiles, ...attFiles];
      const baseText = this.stripMention(ev.text ?? '');
      const fullText = attText ? `${baseText}\n${attText}`.trim() : baseText;
      await this.messageHandler({
        id: event.ts,
        platform: 'slack',
        userId: event.user ?? 'unknown',
        channelId: event.channel,
        threadId: event.thread_ts ?? event.ts,
        text: fullText,
        isDM: false,
        files: allFiles.length > 0 ? allFiles : undefined,
        raw: {
          client,
          messageTs: event.ts,
          bot_id: (event as any).bot_id,
          app_id: (event as any).app_id,
        },
      });
    });

    this.app.message(async ({ message, client }) => {
      const msg = message as any;
      if (!msg.channel?.startsWith('D') || !msg.user) return;
      if (!this.messageHandler) return;
      const { files: attFiles, text: attText } = this.extractFromAttachments(msg.attachments);
      const directFiles = this.mapFiles(msg.files) ?? [];
      const allFiles = [...directFiles, ...attFiles];
      const baseText = this.stripMention(msg.text ?? '');
      const fullText = attText ? `${baseText}\n${attText}`.trim() : baseText;
      await this.messageHandler({
        id: msg.ts,
        platform: 'slack',
        userId: msg.user,
        channelId: msg.channel,
        threadId: msg.thread_ts ?? msg.ts,
        text: fullText,
        isDM: true,
        files: allFiles.length > 0 ? allFiles : undefined,
        raw: {
          client,
          messageTs: msg.ts,
          bot_id: msg.bot_id,
          app_id: msg.app_id,
        },
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

    // ── Message feedback (👍/👎 buttons under the agent's final reply) ──
    this.app.action('fb_up', async ({ ack, body, action, client }) => {
      await ack();
      await this.recordFeedbackClick('up', body as any, action as any, client);
    });
    this.app.action('fb_down', async ({ ack, body, action, client }) => {
      await ack();
      const b = body as any;
      const ctx = this.parseFbValue(action as any);
      // Open the modal FIRST — the Slack trigger_id is only valid for a few
      // seconds, so do it before the slower DB write / users.info / chat.update.
      try {
        await client.views.open({
          trigger_id: b.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'fb_note',
            private_metadata: JSON.stringify({
              ...ctx,
              channel: b.channel?.id ?? b.message?.channel,
              ts: b.message?.ts,
            }),
            title: { type: 'plain_text', text: 'Feedback' },
            submit: { type: 'plain_text', text: 'Send' },
            close: { type: 'plain_text', text: 'Skip' },
            blocks: [{
              type: 'input', block_id: 'note', optional: true,
              label: { type: 'plain_text', text: 'What went wrong? (optional)' },
              element: { type: 'plain_text_input', action_id: 'note_input', multiline: true },
            }],
          },
        });
      } catch (err) { this.log.warn('Feedback modal open failed', { error: (err as Error).message }); }
      // Record the 👎 + collapse the prompt (the note merges on modal submit).
      await this.recordFeedbackClick('down', b, action as any, client);
    });
    this.app.view('fb_note', async ({ ack, body, view, client }) => {
      await ack();
      try {
        const meta = JSON.parse(view.private_metadata || '{}');
        const note = (view.state.values?.note as any)?.note_input?.value ?? '';
        if (!note.trim()) return; // 👎 already recorded on click; nothing to add
        const handle = await this.handleFor(client, (body as any).user?.id);
        await recordMessageFeedback({
          agentId: meta.agentId, activityId: meta.activityId ?? null,
          channel: meta.channel ?? null, messageTs: meta.ts ?? null,
          raterUserId: (body as any).user?.id ?? null, raterHandle: handle,
          sentiment: 'down', note: note.trim(),
        });
      } catch (err) { this.log.warn('Feedback note submit failed', { error: (err as Error).message }); }
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

  // ─── Feedback (👍/👎) ───────────────────────────────────────────────

  /** Post the "Was this helpful?" prompt with 👍/👎 buttons under a reply. */
  async postFeedbackPrompt(
    channelId: string,
    threadId: string | undefined,
    ctx: { agentId: string; activityId?: string | null },
  ): Promise<void> {
    const value = JSON.stringify({ agentId: ctx.agentId, activityId: ctx.activityId ?? null });
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        ...(threadId ? { thread_ts: threadId } : {}),
        text: 'Was this helpful?',
        blocks: [{
          type: 'actions',
          elements: [
            { type: 'button', action_id: 'fb_up',   text: { type: 'plain_text', text: '👍', emoji: true }, value },
            { type: 'button', action_id: 'fb_down', text: { type: 'plain_text', text: '👎', emoji: true }, value },
          ],
        }],
      });
    } catch (err) { this.log.warn('Feedback prompt post failed', { error: (err as Error).message }); }
  }

  /** Parse the {agentId, activityId} context off a feedback button's value. */
  private parseFbValue(action: { value?: string }): { agentId: string; activityId?: string | null } {
    try { return JSON.parse(action?.value ?? '{}'); } catch { return { agentId: '' }; }
  }

  /** Best-effort Slack display name for a user id (for the feedback note list). */
  private async handleFor(client: { users: { info: (a: { user: string }) => Promise<any> } }, userId?: string): Promise<string | null> {
    if (!userId) return null;
    try {
      const r = await client.users.info({ user: userId });
      return (r.user?.profile?.display_name || r.user?.real_name || r.user?.name) ?? null;
    } catch { return null; }
  }

  /** Record a 👍/👎 button click and collapse the prompt into a thank-you. */
  private async recordFeedbackClick(sentiment: 'up' | 'down', body: any, action: any, client: any): Promise<void> {
    const ctx = this.parseFbValue(action);
    const channel = body.channel?.id ?? body.message?.channel;
    const ts = body.message?.ts;
    try {
      const handle = await this.handleFor(client, body.user?.id);
      await recordMessageFeedback({
        agentId: ctx.agentId, activityId: ctx.activityId ?? null,
        channel: channel ?? null, messageTs: ts ?? null,
        raterUserId: body.user?.id ?? null, raterHandle: handle, sentiment,
      });
    } catch (err) { this.log.warn('Feedback record failed', { error: (err as Error).message }); }
    if (channel && ts) {
      const thanks = sentiment === 'up'
        ? '✅ Thanks for your feedback!'
        : '📝 Thanks — your feedback helps us improve.';
      await client.chat.update({ channel, ts, text: thanks, blocks: [] }).catch(() => {});
    }
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
    const channelId = result.channel?.id;
    if (!channelId) {
      throw new Error(`Failed to open DM with user ${userId}: Slack did not return a channel ID`);
    }
    return channelId;
  }

  // ─── Formatting ────────────────────────────────────────────────────

  getFormattingRules(): string {
    // Single source of truth lives in compile-claude-md.SLACK_FORMATTING_SECTION
    // — keeps the production-adapter path and the no-adapter fallback identical.
    return SLACK_FORMATTING_SECTION;
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

  // ─── Link resolution ──────────────────────────────────────────────

  /**
   * Resolve a Slack permalink into the referenced message's text and files.
   *
   * - Thread reply links (`?thread_ts=...`) are fetched via conversations.replies
   *   so the exact reply is returned, not just the thread parent.
   * - Sender name reuses getUserDisplayName (no extra users.info call).
   * - Channel name is omitted to avoid a conversations.info round-trip; the
   *   channel ID from the URL gives enough context.
   */
  async resolveLinkedMessage(url: string): Promise<{ text: string; files: FileAttachment[] } | null> {
    const parsed = parseSlackPermalink(url);
    if (!parsed) return null;
    const { channelId, ts, threadTs } = parsed;
    try {
      let msg: any | undefined;
      if (threadTs) {
        // Thread reply — fetch via conversations.replies and find the exact message
        const result = await this.app.client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          latest: ts,
          oldest: ts,
          inclusive: true,
          limit: 10,
        });
        msg = (result.messages as any[])?.find((m: any) => m.ts === ts);
      } else {
        const result = await this.app.client.conversations.history({
          channel: channelId,
          latest: ts,
          oldest: ts,
          inclusive: true,
          limit: 1,
        });
        msg = result.messages?.[0];
      }
      if (!msg) return null;

      // Reuse existing getUserDisplayName — avoids an extra users.info round-trip.
      let senderName = msg.user ?? msg.bot_id ?? 'unknown';
      if (msg.user) {
        try { senderName = await this.getUserDisplayName(msg.user); } catch { /* fall back to ID */ }
      }

      const rawText = msg.text ?? '';
      const text = `from ${senderName} in <#${channelId}>:\n${rawText}`;
      const files = this.mapFiles(msg.files) ?? [];
      return { text, files };
    } catch (err) {
      this.log.warn('resolveLinkedMessage failed', { url, error: (err as Error).message });
      return null;
    }
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

  // Extract files and text buried inside Slack attachment objects (forwarded/shared messages).
  // Slack puts the original message's content in event.attachments[] rather than event.files[].
  private extractFromAttachments(attachments?: any[]): { files: FileAttachment[]; text: string } {
    if (!attachments || attachments.length === 0) return { files: [], text: '' };
    const files: FileAttachment[] = [];
    const textParts: string[] = [];
    for (const att of attachments) {
      if (att.text) textParts.push(att.text);
      if (att.pretext) textParts.push(att.pretext);
      const attFiles = this.mapFiles(att.files);
      if (attFiles) files.push(...attFiles);
    }
    return { files, text: textParts.join('\n') };
  }
}

// =============================================================================
// Slack permalink parser (exported for tests)
// =============================================================================

/**
 * Parse a Slack message permalink into its channel ID and API timestamp.
 * Slack encodes `1234567890.123456` as `p1234567890123456` in URLs.
 * Returns null if the URL is not a recognisable Slack archive link.
 */
export function parseSlackPermalink(url: string): { channelId: string; ts: string; threadTs?: string } | null {
  const match = /\/archives\/([A-Za-z0-9]+)\/p(\d+)/.exec(url);
  if (!match) return null;
  const channelId = match[1];
  const raw = match[2];
  const ts = raw.length > 6 ? `${raw.slice(0, -6)}.${raw.slice(-6)}` : raw;
  // Thread reply links include ?thread_ts=<parent_ts> — parse it so we can
  // fetch the exact reply via conversations.replies instead of the parent.
  const threadTsParam = new URL(url, 'https://slack.com').searchParams.get('thread_ts') ?? undefined;
  return { channelId, ts, threadTs: threadTsParam };
}

/**
 * Extract up to `limit` Slack permalink URLs from mrkdwn text.
 * Handles both angle-bracket form `<https://…|label>` and bare URLs.
 */
export function extractSlackPermalinkUrls(text: string, limit = 3): string[] {
  const urlRe = /<(https:\/\/[^|>]+slack\.com\/archives\/[^|>]+)(?:\|[^>]*)?>|https?:\/\/\S+slack\.com\/archives\/\S+/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null && urls.length < limit) {
    const url = m[1] ?? m[0];
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
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
