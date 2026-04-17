/**
 * @fileoverview Platform-agnostic message handler.
 *
 * Orchestrates the message flow without knowing which platform is being used:
 *   receive → check restrictions → build prompt → stream to Claude → post response
 *
 * All platform interaction goes through the PlatformAdapter interface.
 * All Claude interaction goes through ClaudeHandler.
 *
 * @module runner/message-handler
 */

import type { PlatformAdapter, IncomingMessage, FileAttachment } from '@slackhive/shared';
import type { Agent, Restriction } from '@slackhive/shared';
import type { ClaudeHandler } from './claude-handler';
import { CorrectionHandler } from './correction-handler';
import { agentLogger } from './logger';
import type { Logger } from 'winston';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

const MAX_THREAD_CONTEXT_CHARS = 8_000;

/** Max bytes for text file content. */
const MAX_TEXT_FILE_BYTES = 512 * 1024;

export class MessageHandler {
  private log: Logger;
  private correctionHandler: CorrectionHandler;
  private activeControllers = new Map<string, AbortController>();
  private currentReactions = new Map<string, string>();

  constructor(
    private adapter: PlatformAdapter,
    private claudeHandler: ClaudeHandler,
    private agent: Agent,
    private restrictions: Restriction | null,
  ) {
    this.log = agentLogger(agent.slug);
    this.correctionHandler = new CorrectionHandler(agent);
  }

  /**
   * Handle an incoming message from any platform.
   * This is the core message flow — platform-agnostic.
   */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { userId, channelId, threadId, text, files } = msg;
    const messageId = msg.id;

    if (!text && (!files || files.length === 0)) return;

    // Check channel restrictions
    if (this.isChannelRestricted(channelId)) return;

    // Route correction commands — still uses raw platform client for now
    // Will be fully adapter-based when CorrectionHandler is refactored
    const rawClient = (msg.raw as any)?.client;
    if (this.correctionHandler.isCommand(text) && rawClient) {
      await this.correctionHandler.handle(
        { userId, channelId, threadTs: threadId, messageTs: messageId },
        text,
        rawClient,
      );
      return;
    }

    const sessionKey = this.claudeHandler.getSessionKey(userId, channelId, threadId);
    this.log.info('Processing message', { userId, channelId, threadId, sessionKey, textLength: text.length });

    // Abort any in-flight request for this session
    this.activeControllers.get(sessionKey)?.abort();
    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    // Thinking reaction + status message
    await this.swapReaction(channelId, messageId, sessionKey, 'thinking_face');

    let statusMsgId: string | undefined;
    try {
      statusMsgId = await this.adapter.postMessage(channelId, '*Thinking...*', threadId);
    } catch (err) {
      this.log.error('Failed to post status message', { error: err });
      return;
    }

    // Build prompt with thread context + files
    const prompt = await this.buildPrompt(channelId, threadId, text, files);

    let sentMessages: string[] = [];
    let lastAssistantText: string | null = null;
    let lastToolResultText: string | null = null;

    try {
      for await (const message of this.claudeHandler.streamQuery(prompt, sessionKey, abortController)) {
        if (abortController.signal.aborted) break;

        if (message.type === 'assistant') {
          const content: any[] = (message as any).message?.content ?? [];
          const hasToolUse = content.some((b: any) => b.type === 'tool_use');

          const textContent = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          if (textContent) lastAssistantText = textContent;

          if (hasToolUse) {
            await this.swapReaction(channelId, messageId, sessionKey, 'gear');
            // Update status with tool info
            const toolStatus = this.formatToolStatus(content);
            if (statusMsgId && toolStatus) {
              await this.adapter.updateMessage(channelId, statusMsgId, toolStatus).catch(() => {});
            }
          } else if (textContent) {
            if (textContent.includes('authentication_error') || textContent.includes('Failed to authenticate')) continue;
            if (this.agent.verbose !== false) {
              sentMessages.push(textContent);
              await this.postFormattedMessage(channelId, threadId, textContent);
            }
            // non-verbose: lastAssistantText already updated above; fallback posts it at end
          }
        } else if (message.type === 'user') {
          const userContent = (message as any).message?.content;
          if (Array.isArray(userContent)) {
            for (const part of userContent) {
              if (part.type === 'tool_result' && typeof part.content === 'string' && part.content.length > 0) {
                lastToolResultText = part.content;
              } else if (part.type === 'tool_result' && Array.isArray(part.content)) {
                const textParts = part.content.filter((p: any) => p.type === 'text').map((p: any) => p.text);
                if (textParts.length > 0) lastToolResultText = textParts.join('');
              }
            }
          }
        } else if (message.type === 'result') {
          this.log.info('Query completed', {
            cost: (message as any).total_cost_usd,
            duration_ms: (message as any).duration_ms,
            status: (message as any).subtype,
            num_turns: (message as any).num_turns,
          });

          if ((message as any).subtype === 'success') {
            const finalResult = (message as any).result as string | undefined;
            if (finalResult && !sentMessages.includes(finalResult)) {
              sentMessages.push(finalResult);
              await this.postFormattedMessage(channelId, threadId, finalResult);
            }
          }
        }
      }

      // Fallback if no messages were sent
      if (sentMessages.length === 0) {
        const fallback = lastAssistantText ?? lastToolResultText ?? '_No response generated._';
        this.log.info('No messages sent, using fallback');
        await this.postFormattedMessage(channelId, threadId, fallback);
      }

      // Done
      if (statusMsgId) {
        await this.adapter.updateMessage(channelId, statusMsgId, '*Done*').catch(() => {});
      }
      await this.swapReaction(channelId, messageId, sessionKey, 'white_check_mark');

    } catch (error: any) {
      if (error?.name === 'AbortError') {
        this.log.debug('Request aborted', { sessionKey });
        if (statusMsgId) await this.adapter.updateMessage(channelId, statusMsgId, '*Cancelled*').catch(() => {});
        await this.swapReaction(channelId, messageId, sessionKey, 'stop_button');
      } else {
        this.log.error('Error streaming Claude response', { sessionKey, error: error?.message });
        const errText = error?.message?.startsWith('AUTH_EXPIRED:')
          ? 'Authentication expired. Please run `claude login` on the host.'
          : `Something went wrong: \`${error?.message ?? 'Unknown error'}\``;
        if (statusMsgId) await this.adapter.updateMessage(channelId, statusMsgId, errText).catch(() => {});
        await this.swapReaction(channelId, messageId, sessionKey, 'x');
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      setTimeout(() => this.currentReactions.delete(sessionKey), 5 * 60 * 1000);
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────

  /** Post a message formatted for the platform (with rich blocks if supported). */
  private async postFormattedMessage(channelId: string, threadId: string | undefined, text: string): Promise<void> {
    const payloads = this.adapter.buildPayloads(text);
    for (const payload of payloads) {
      await this.adapter.postPayload(channelId, payload, threadId);
    }
  }

  /** Swap reaction — remove old, add new. */
  private async swapReaction(channelId: string, messageId: string, sessionKey: string, emoji: string): Promise<void> {
    const current = this.currentReactions.get(sessionKey);
    if (current === emoji) return;
    if (current) await this.adapter.removeReaction(channelId, messageId, current);
    await this.adapter.postReaction(channelId, messageId, emoji);
    this.currentReactions.set(sessionKey, emoji);
  }

  /** Check if channel is restricted. */
  private isChannelRestricted(channelId: string): boolean {
    if (!this.restrictions || this.restrictions.allowedChannels.length === 0) return false;
    return !this.restrictions.allowedChannels.includes(channelId);
  }

  /** Build prompt with thread context + files. */
  private async buildPrompt(
    channelId: string,
    threadId: string | undefined,
    userText: string,
    files?: FileAttachment[],
  ): Promise<string | ContentBlockParam[]> {
    // Fetch thread context via adapter
    let threadContext = '';
    if (threadId) {
      try {
        const messages = await this.adapter.getThreadMessages(channelId, threadId, 20);
        if (messages.length > 0) {
          const contextLines: string[] = [];
          const nameCache = new Map<string, string>();

          for (const m of messages) {
            let speaker: string;
            if (m.isBot) {
              speaker = this.agent.name;
            } else {
              if (!nameCache.has(m.userId)) {
                nameCache.set(m.userId, await this.adapter.getUserDisplayName(m.userId));
              }
              const name = nameCache.get(m.userId) ?? m.userId;
              speaker = `${name} (${m.userId})`;
            }
            contextLines.push(`${speaker}: ${m.text}`);
          }

          let context = contextLines.join('\n');
          if (context.length > MAX_THREAD_CONTEXT_CHARS) {
            context = '...' + context.slice(-MAX_THREAD_CONTEXT_CHARS);
          }
          threadContext = `[Thread context]\n${context}\n\n`;
        }
      } catch (err) {
        this.log.warn('Failed to fetch thread context', { error: err });
      }
    }

    // Download files via adapter
    const textChunks: string[] = [];
    const binaryBlocks: ContentBlockParam[] = [];

    if (files && files.length > 0) {
      for (const file of files) {
        if (!file.url) continue;
        const kind = this.getFileKind(file);
        if (kind === 'unsupported') continue;

        try {
          const buffer = await this.adapter.downloadFile(file.url);
          const label = file.name;

          if (kind === 'text') {
            let text = new TextDecoder().decode(buffer.slice(0, MAX_TEXT_FILE_BYTES));
            if (buffer.byteLength > MAX_TEXT_FILE_BYTES) text += '\n[... truncated at 512 KB ...]';
            textChunks.push(`[File: ${label}]\n${text}`);
          } else if (kind === 'image') {
            const mt = file.mimeType ?? 'image/jpeg';
            binaryBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: mt as any, data: Buffer.from(buffer).toString('base64') },
            } as ContentBlockParam);
          } else if (kind === 'pdf') {
            binaryBlocks.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(buffer).toString('base64') },
              title: label,
            } as ContentBlockParam);
          }
        } catch (err) {
          this.log.warn('Error downloading file', { name: file.name, error: err });
        }
      }
    }

    const textPrompt = `${threadContext}${textChunks.length > 0 ? textChunks.join('\n\n') + '\n\n' : ''}${userText}`.trim();

    if (binaryBlocks.length > 0) {
      const blocks: ContentBlockParam[] = [];
      if (textPrompt) blocks.push({ type: 'text', text: textPrompt });
      blocks.push(...binaryBlocks);
      return blocks;
    }

    return textPrompt;
  }

  /** Classify file type. */
  private getFileKind(file: FileAttachment): 'text' | 'image' | 'pdf' | 'unsupported' {
    const mt = file.mimeType ?? '';
    const ft = (file.fileType ?? '').toLowerCase();
    if (mt === 'application/pdf' || ft === 'pdf') return 'pdf';
    if (mt.startsWith('image/')) return 'image';
    if (mt.startsWith('text/') || ['json', 'yaml', 'xml', 'sql', 'py', 'js', 'ts', 'go', 'rs', 'csv', 'md'].includes(ft)) return 'text';
    return 'unsupported';
  }

  /** Format tool_use blocks into status text. */
  private formatToolStatus(content: any[]): string | null {
    if ('formatToolStatus' in this.adapter) {
      return (this.adapter as any).formatToolStatus(content);
    }
    // Generic fallback
    for (const block of content) {
      if (block.type === 'tool_use') return '*Working...*';
    }
    return null;
  }
}
