/**
 * @fileoverview Telegram platform adapter implementing PlatformAdapter.
 *
 * Wraps grammy Bot and extracts all Telegram-specific logic:
 * - Long-polling connection lifecycle (no public webhook surface required)
 * - HTML parse mode formatting (markdown → Telegram HTML)
 * - File upload/download via Bot API
 * - Reactions via setMessageReaction (Bot API 7.0+)
 * - Mention formatting and stripping
 * - Formatting rules for CLAUDE.md injection
 *
 * The brain (ClaudeHandler) and message flow (MessageHandler) never
 * import grammy — they talk only through the PlatformAdapter interface.
 *
 * @module runner/adapters/telegram-adapter
 */

import { Bot, GrammyError, InputFile } from 'grammy';
import type { ReactionTypeEmoji } from '@grammyjs/types';
import type {
  PlatformAdapter, IncomingMessage, ThreadMessage, FileAttachment, MessagePayload,
  TelegramCredentials,
} from '@slackhive/shared';
import { agentLogger } from '../logger';
import type { Logger } from 'winston';

// =============================================================================
// Constants
// =============================================================================

/** Telegram's hard message-length cap in characters. */
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * Mapping from Slack-style emoji names / standard names to the subset of
 * emoji that Telegram's Bot API 7.0+ accepts for setMessageReaction.
 * Returns null to no-op when no mapping exists.
 */
const EMOJI_MAP: Record<string, string | null> = {
  white_check_mark: '👍', heavy_check_mark: '👍', check: '👍',
  thumbsup: '👍', '+1': '👍',
  thumbsdown: '👎', '-1': '👎',
  x: '👎', no_entry_sign: '👎',
  eyes: '👀', thinking_face: '🤔',
  fire: '🔥', rocket: '🔥',
  heart: '❤', tada: '🎉',
};

// =============================================================================
// TelegramAdapter
// =============================================================================

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram';

  private bot!: Bot;
  private log: Logger;
  private botUserId?: string;
  private botUsername?: string;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private credentials: TelegramCredentials;
  private stopController?: AbortController;

  constructor(credentials: TelegramCredentials, agentSlug: string) {
    this.credentials = credentials;
    this.log = agentLogger(agentSlug);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Pre-flight credential probe — catches invalid tokens before wiring up
    // the long-polling loop, mirroring SlackAdapter's auth.test approach.
    let botUsername: string;
    try {
      const probe = new Bot(this.credentials.botToken);
      const me = await probe.api.getMe();
      this.botUserId = String(me.id);
      botUsername = me.username ?? String(me.id);
      this.botUsername = botUsername;
    } catch (err) {
      const e = err as Error & { error_code?: number };
      const friendly =
        e.error_code === 401
          ? 'Telegram bot token is invalid. Paste a fresh token from @BotFather in Settings → Platform Integrations.'
          : `Telegram auth failed: ${e.message}`;
      this.log.warn('Telegram credential probe failed', { error: e.message });
      throw new Error(friendly);
    }

    // Probe passed — build the real Bot instance with all event handlers.
    this.bot = new Bot(this.credentials.botToken);

    this.bot.on('message', async (ctx) => {
      if (!this.messageHandler) return;
      const msg = ctx.message;
      if (!msg.from) return;

      const files = await this.extractFiles(msg);
      const rawText = msg.text ?? msg.caption ?? '';
      const text = this.stripMention(rawText);

      // Only respond to DMs or when the bot is explicitly mentioned in groups
      const isDM = msg.chat.type === 'private';
      const isMentioned = rawText.includes(`@${botUsername}`);
      if (!isDM && !isMentioned) return;

      await this.messageHandler({
        id: String(msg.message_id),
        platform: 'telegram',
        userId: String(msg.from.id),
        channelId: String(msg.chat.id),
        threadId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
        text,
        isDM,
        files: files.length > 0 ? files : undefined,
        raw: ctx,
      });
    });

    // Start long-polling without awaiting — grammy's start() only resolves
    // when stop() is called, so we fire-and-forget and log any unexpected errors.
    const startPromise = this.bot.start({ drop_pending_updates: true });
    startPromise.catch((err: Error) => {
      this.log.error('Telegram long-polling error', { error: err.message });
    });

    this.log.info('Telegram adapter started', { botUserId: this.botUserId, username: botUsername });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
    }
  }

  getBotUserId(): string | undefined {
    return this.botUserId;
  }

  // ─── Receive ───────────────────────────────────────────────────────

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // ─── Send ──────────────────────────────────────────────────────────

  async postMessage(channelId: string, text: string, threadId?: string): Promise<string> {
    const chunks = this.chunkText(text);
    let lastId = '';
    const replyOpt = threadId ? { reply_to_message_id: Number(threadId) } : {};
    for (const chunk of chunks) {
      try {
        const sent = await this.bot.api.sendMessage(Number(channelId), chunk, {
          parse_mode: 'HTML',
          ...replyOpt,
        });
        lastId = String(sent.message_id);
      } catch (err) {
        // If HTML parsing fails, fall back to plain text
        this.log.warn('Telegram sendMessage HTML failed, retrying as plain', { error: (err as Error).message });
        const plain = this.stripHtmlTags(chunk);
        const sent = await this.bot.api.sendMessage(Number(channelId), plain, { ...replyOpt });
        lastId = String(sent.message_id);
      }
    }
    return lastId;
  }

  async postPayload(channelId: string, payload: MessagePayload, threadId?: string): Promise<string> {
    // Telegram has no Block Kit equivalent — post as plain text
    return this.postMessage(channelId, payload.text, threadId);
  }

  async updateMessage(channelId: string, messageId: string, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(Number(channelId), Number(messageId), text, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      const e = err as GrammyError;
      // Swallow "message is not modified" — Telegram throws on idempotent edits
      if (e.description?.includes('message is not modified')) return;
      throw err;
    }
  }

  async postReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const mapped = EMOJI_MAP[emoji.replace(/:/g, '')] ?? null;
    if (!mapped) return;
    try {
      await this.bot.api.setMessageReaction(
        Number(channelId),
        Number(messageId),
        [{ type: 'emoji', emoji: mapped as ReactionTypeEmoji['emoji'] }],
      );
    } catch { /* reactions are non-critical — swallow any error */ }
  }

  async removeReaction(channelId: string, messageId: string, _emoji: string): Promise<void> {
    try {
      await this.bot.api.setMessageReaction(Number(channelId), Number(messageId), []);
    } catch { /* non-critical */ }
  }

  async uploadFile(channelId: string, content: string | Buffer, filename: string, threadId?: string): Promise<void> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await this.bot.api.sendDocument(
      Number(channelId),
      new InputFile(buf, filename),
      {
        ...(threadId && { reply_to_message_id: Number(threadId) }),
      },
    );
  }

  // ─── Context ───────────────────────────────────────────────────────

  async getThreadMessages(_channelId: string, _threadId: string, _limit: number): Promise<ThreadMessage[]> {
    // Telegram Bot API has no thread-history endpoint — return empty.
    // The brain tolerates an empty list; Slack's richer history is a nicety.
    return [];
  }

  async getUserDisplayName(userId: string): Promise<string> {
    // getChatMember is chat-scoped; without a chat ID we can't call it here.
    // TODO: cache display names keyed by (chatId, userId) in a future update.
    return userId;
  }

  async openDm(userId: string): Promise<string> {
    // In Telegram, a user's private chat ID equals their user ID.
    return userId;
  }

  // ─── Formatting ────────────────────────────────────────────────────

  getFormattingRules(): string {
    return [
      'Platform: Telegram (HTML parse mode).',
      'Bold: <b>bold</b> — NOT **bold** or *bold*.',
      'Italic: <i>italic</i>.',
      'Code inline: <code>x</code>.',
      'Code block: <pre><code class="language-python">…</code></pre>.',
      'Links: <a href="url">label</a>.',
      'Mentions: <a href="tg://user?id=123456">Name</a>.',
      'Do NOT use Slack-style <@Uxxx> mentions or *single-asterisk-bold*.',
      'Keep messages under 4096 characters; split naturally at paragraph boundaries.',
    ].join('\n');
  }

  formatMarkdown(md: string): string {
    // Process block-level elements first, then inline
    let html = md;

    // Fenced code blocks (```lang\n…\n```)
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, lang, code) => {
      const langAttr = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${langAttr}>${this.htmlEscape(code.trimEnd())}</code></pre>`;
    });

    // ATX headings (## Heading → <b>Heading</b>)
    html = html.replace(/^#{1,6}\s+(.+)$/gm, (_m, content) => `<b>${content.trim()}</b>`);

    // Bold (**text** or __text__)
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/__(.+?)__/g, '<b>$1</b>');

    // Italic (*text* or _text_) — avoid matching inside bold markers already converted
    html = html.replace(/\*([^*\n]+?)\*/g, '<i>$1</i>');
    html = html.replace(/_([^_\n]+?)_/g, '<i>$1</i>');

    // Inline code (`code`)
    html = html.replace(/`([^`\n]+?)`/g, '<code>$1</code>');

    return html;
  }

  buildPayloads(text: string, _isFinal?: boolean): MessagePayload[] {
    return this.chunkText(text).map(chunk => ({ text: chunk }));
  }

  formatMention(userId: string): string {
    return `<a href="tg://user?id=${userId}">user</a>`;
  }

  stripMention(text: string): string {
    if (!this.botUsername) return text;
    // Strip @botUsername from the beginning of the message (common group mention pattern)
    return text.replace(new RegExp(`^@${this.botUsername}\\s*`, 'i'), '').trim();
  }

  parseMentions(text: string): string[] {
    const ids = new Set<string>();
    // tg://user?id=123456 links (from formatMention)
    for (const m of text.matchAll(/tg:\/\/user\?id=(\d+)/g)) ids.add(m[1]);
    // @username mentions (5+ chars to avoid false positives)
    for (const m of text.matchAll(/@([a-zA-Z0-9_]{5,})/g)) ids.add(m[1]);
    return [...ids];
  }

  async downloadFile(url: string): Promise<Buffer> {
    // Telegram file URLs embed the bot token in the path — no auth header needed
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private htmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private stripHtmlTags(s: string): string {
    return s.replace(/<[^>]+>/g, '');
  }

  private chunkText(text: string): string[] {
    if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > TELEGRAM_MAX_MESSAGE_CHARS) {
      // Try to break at a paragraph boundary within the limit
      let cut = remaining.lastIndexOf('\n\n', TELEGRAM_MAX_MESSAGE_CHARS);
      if (cut < TELEGRAM_MAX_MESSAGE_CHARS / 2) {
        cut = remaining.lastIndexOf('\n', TELEGRAM_MAX_MESSAGE_CHARS);
      }
      if (cut <= 0) cut = TELEGRAM_MAX_MESSAGE_CHARS;
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }

  private async extractFiles(msg: any): Promise<FileAttachment[]> {
    const files: FileAttachment[] = [];

    // Document
    if (msg.document) {
      const doc = msg.document;
      const file = await this.buildFileAttachment(
        doc.file_id,
        doc.file_name ?? 'file',
        doc.mime_type,
        doc.file_size,
      );
      if (file) files.push(file);
    }

    // Photo (take highest resolution)
    if (msg.photo?.length) {
      const photo = msg.photo[msg.photo.length - 1];
      const file = await this.buildFileAttachment(photo.file_id, 'photo.jpg', 'image/jpeg', photo.file_size);
      if (file) files.push(file);
    }

    // Voice
    if (msg.voice) {
      const voice = msg.voice;
      const file = await this.buildFileAttachment(voice.file_id, 'voice.ogg', voice.mime_type ?? 'audio/ogg', voice.file_size);
      if (file) files.push(file);
    }

    return files;
  }

  private async buildFileAttachment(
    fileId: string,
    name: string,
    mimeType?: string,
    size?: number,
  ): Promise<FileAttachment | null> {
    try {
      const f = await this.bot.api.getFile(fileId);
      if (!f.file_path) return null;
      const url = `https://api.telegram.org/file/bot${this.credentials.botToken}/${f.file_path}`;
      return { id: fileId, name, mimeType, size, url };
    } catch {
      return null;
    }
  }
}
