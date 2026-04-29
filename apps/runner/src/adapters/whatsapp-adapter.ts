/**
 * @fileoverview WhatsApp Cloud API platform adapter implementing PlatformAdapter.
 *
 * Uses Meta's WhatsApp Cloud API (graph.facebook.com) for all messaging.
 * Unlike Slack (Socket Mode), WhatsApp is webhook-driven: Meta POSTs events
 * to a public URL (apps/web webhook route), which forwards them to the runner's
 * internal server, which calls handleWebhook() on this adapter.
 *
 * Lifecycle:
 *   start()         → validates credentials via Graph API probe, no socket opened
 *   handleWebhook() → called by runner's /whatsapp internal endpoint per event
 *   stop()          → no-op (no persistent connection)
 *
 * Threading model: WhatsApp has no native threads. Each sender phone number is
 * treated as its own "thread" so conversation context (getThreadMessages) works
 * through the same code path the rest of the platform uses.
 *
 * @module runner/adapters/whatsapp-adapter
 */

import type {
  PlatformAdapter, IncomingMessage, ThreadMessage, FileAttachment, MessagePayload,
  WhatsAppCredentials,
} from '@slackhive/shared';
import { agentLogger } from '../logger';
import type { Logger } from 'winston';

// =============================================================================
// Constants
// =============================================================================

const GRAPH_API_BASE = 'https://graph.facebook.com/v18.0';
const MAX_MESSAGE_LENGTH = 4096;

// =============================================================================
// WhatsAppAdapter
// =============================================================================

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp';

  private log: Logger;
  private credentials: WhatsAppCredentials;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  // In-memory conversation history keyed by sender phone number (used as threadId)
  private conversationHistory: Map<string, ThreadMessage[]> = new Map();

  constructor(credentials: WhatsAppCredentials, agentSlug: string) {
    this.credentials = credentials;
    this.log = agentLogger(agentSlug);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    try {
      await this.apiGet(`/${this.credentials.phoneNumberId}`);
      this.log.info('WhatsApp adapter started', { phoneNumberId: this.credentials.phoneNumberId });
    } catch (err) {
      const raw = (err as Error).message;
      const friendly = /invalid.*token|token.*invalid|OAuthException/i.test(raw)
        ? 'WhatsApp access token is invalid or expired. Paste a fresh permanent token in Settings → Platform Integrations.'
        : `WhatsApp auth failed: ${raw}`;
      this.log.warn('WhatsApp credential probe failed', { error: raw });
      throw new Error(friendly);
    }
  }

  async stop(): Promise<void> {
    // No persistent connection to close
  }

  getBotUserId(): string | undefined {
    return this.credentials.phoneNumberId;
  }

  // ─── Receive ───────────────────────────────────────────────────────

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Entry point for inbound events. Called by the runner's /whatsapp internal
   * endpoint for each `entry` object in the Meta webhook payload.
   */
  async handleWebhook(entry: any): Promise<void> {
    if (!this.messageHandler) return;

    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (change.field !== 'messages' || !value?.messages) continue;

      for (const msg of value.messages) {
        const senderId: string = msg.from;
        const msgId: string = msg.id;
        const profile = (value.contacts as any[])?.find((c: any) => c.wa_id === senderId);
        const displayName: string | undefined = profile?.profile?.name;

        let text = '';
        const files: FileAttachment[] = [];

        if (msg.type === 'text') {
          text = msg.text?.body ?? '';
        } else if (msg.type === 'image' || msg.type === 'document' || msg.type === 'audio' || msg.type === 'video') {
          const media = msg[msg.type];
          text = media?.caption ?? '';
          if (media?.id) {
            files.push({
              id: media.id,
              name: media.filename ?? `${msg.type}-${media.id}`,
              mimeType: media.mime_type,
              url: media.id, // resolved in downloadFile()
            });
          }
        } else {
          // Unsupported type (location, contacts, sticker, etc.) — skip
          continue;
        }

        const history = this.conversationHistory.get(senderId) ?? [];
        history.push({ userId: senderId, displayName, text, isBot: false });
        this.conversationHistory.set(senderId, history);

        await this.messageHandler({
          id: msgId,
          platform: 'whatsapp',
          userId: senderId,
          channelId: senderId, // 1:1 — channel = sender's phone number
          threadId: senderId,  // treat each contact as a "thread"
          text,
          isDM: true,
          files: files.length > 0 ? files : undefined,
          raw: msg,
        });
      }
    }
  }

  // ─── Send ──────────────────────────────────────────────────────────

  async postMessage(channelId: string, text: string, _threadId?: string): Promise<string> {
    const chunks = this.chunkText(this.formatMarkdown(text));
    let lastId = '';
    for (const chunk of chunks) {
      const res = await this.apiPost(`/${this.credentials.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: channelId,
        type: 'text',
        text: { body: chunk, preview_url: false },
      }) as { messages?: Array<{ id: string }> };
      lastId = res.messages?.[0]?.id ?? '';
    }

    const history = this.conversationHistory.get(channelId) ?? [];
    history.push({ userId: this.credentials.phoneNumberId, text, isBot: true });
    this.conversationHistory.set(channelId, history);

    return lastId;
  }

  async postPayload(channelId: string, payload: MessagePayload, threadId?: string): Promise<string> {
    return this.postMessage(channelId, payload.text, threadId);
  }

  async updateMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {
    // WhatsApp does not support message editing
  }

  async postReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.apiPost(`/${this.credentials.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: channelId,
        type: 'reaction',
        reaction: { message_id: messageId, emoji },
      });
    } catch { /* non-fatal */ }
  }

  async removeReaction(channelId: string, messageId: string, _emoji: string): Promise<void> {
    try {
      await this.apiPost(`/${this.credentials.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: channelId,
        type: 'reaction',
        reaction: { message_id: messageId, emoji: '' }, // empty string removes reaction
      });
    } catch { /* non-fatal */ }
  }

  async uploadFile(channelId: string, content: string | Buffer, filename: string, _threadId?: string): Promise<void> {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const mediaId = await this.uploadMedia(buffer, filename);
    await this.apiPost(`/${this.credentials.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: channelId,
      type: 'document',
      document: { id: mediaId, filename },
    });
  }

  // ─── Context ───────────────────────────────────────────────────────

  async getThreadMessages(_channelId: string, threadId: string, limit: number): Promise<ThreadMessage[]> {
    const history = this.conversationHistory.get(threadId) ?? [];
    return history.slice(0, -1).slice(-limit);
  }

  async getUserDisplayName(userId: string): Promise<string> {
    // WhatsApp has no public profile lookup for contacts — return formatted phone
    return `+${userId}`;
  }

  async openDm(userId: string): Promise<string> {
    return userId; // channel = phone number
  }

  // ─── Formatting ────────────────────────────────────────────────────

  getFormattingRules(): string {
    return `# WhatsApp Formatting

You are responding in WhatsApp. Follow these rules for every message:

**Text formatting:**
- Bold: *bold* (single asterisk, no spaces inside)
- Italic: _italic_ (single underscore)
- Strikethrough: ~strikethrough~
- Monospace/code block: \`\`\`code\`\`\` (triple backtick on same line)
- Inline code: \`code\`

**Structure:**
- Keep responses concise — WhatsApp is a mobile messaging app
- Use line breaks to separate sections
- Avoid markdown tables — they don't render in WhatsApp; use plain lists instead
- Lists: use "- item" or "1. item"

**Never use:** HTML, ## headings, **double-asterisk bold**, or markdown table syntax`;
  }

  formatMarkdown(md: string): string {
    let formatted = md;
    // ## Headings → *Heading* (bold)
    formatted = formatted.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
    // **bold** → *bold*
    formatted = formatted.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    // __italic__ → _italic_
    formatted = formatted.replace(/__([^_\n]+)__/g, '_$1_');
    // Remove horizontal rules
    formatted = formatted.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '');
    // Strip markdown table rows (pipes with dashes) — can't render in WhatsApp
    formatted = formatted.replace(/^\|[-: |]+\|$/gm, '');
    return formatted;
  }

  buildPayloads(text: string, _isFinal?: boolean): MessagePayload[] {
    return [{ text: this.formatMarkdown(text) }];
  }

  formatMention(userId: string): string {
    return `+${userId}`;
  }

  stripMention(text: string): string {
    return text.trim();
  }

  parseMentions(_text: string): string[] {
    return [];
  }

  async downloadFile(url: string): Promise<Buffer> {
    // `url` is the media ID from the webhook — resolve to a download URL first
    try {
      const mediaInfo = await this.apiGet(`/${url}`) as { url?: string };
      const downloadUrl = mediaInfo.url;
      if (!downloadUrl) throw new Error('No download URL in media response');
      const res = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch {
      // Fallback: treat url as a direct URL
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private async apiGet(path: string): Promise<unknown> {
    const res = await fetch(`${GRAPH_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
    });
    const data = await res.json() as { error?: { message?: string } };
    if (!res.ok) throw new Error(data?.error?.message ?? `API error ${res.status}`);
    return data;
  }

  private async apiPost(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${GRAPH_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { error?: { message?: string } };
    if (!res.ok) throw new Error(data?.error?.message ?? `API error ${res.status}`);
    return data;
  }

  private async uploadMedia(content: Buffer, filename: string): Promise<string> {
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'bin';
    const mimeType = ext === 'pdf' ? 'application/pdf'
      : ext === 'png' ? 'image/png'
      : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
      : 'application/octet-stream';

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([content], { type: mimeType }), filename);

    const res = await fetch(`${GRAPH_API_BASE}/${this.credentials.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
      body: form,
    });
    const data = await res.json() as { id?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(data?.error?.message ?? `Media upload error ${res.status}`);
    return data.id!;
  }

  private chunkText(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    return chunks;
  }
}
