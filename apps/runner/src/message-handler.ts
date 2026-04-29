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
import { extractSlackPermalinkUrls } from './adapters/slack-adapter';
import type { Agent, Restriction, Platform } from '@slackhive/shared';
import {
  upsertTask,
  beginActivity,
  finishActivity,
  beginToolCall,
  finishToolCall,
  recordActivityUsage,
} from '@slackhive/shared';
import type { ClaudeHandler } from './claude-handler';
import { CorrectionHandler } from './correction-handler';
import { agentLogger } from './logger';
import type { Logger } from 'winston';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

/**
 * Feature flag — when unset, all activity-recorder hooks no-op so the Slack
 * hot path never touches the new tables. Read fresh each call so toggling
 * `.env` + restart is enough.
 */
function activityDashboardEnabled(): boolean {
  return process.env.ACTIVITY_DASHBOARD === '1';
}

/** Stringify arbitrary JSON for an `args_preview` column, safely. */
function safeJsonPreview(value: unknown): string | undefined {
  if (value == null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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

    // Build prompt with sender header + thread context + files
    const platform = msg.platform || this.adapter.platform || 'unknown';
    const prompt = await this.buildPrompt(userId, channelId, threadId, text, files, platform);

    // Activity dashboard recorder — no-ops when ACTIVITY_DASHBOARD is off.
    // A Slack thread == one task; each agent's reply in the thread is a new
    // activity row under that task. The runner holds activityId for the
    // duration of this stream and pairs tool_use ids → tool_call db ids.
    const recorder = await this.openActivity(msg, text);
    const toolUseIdToDbId = new Map<string, string>();

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
            // Record each tool_use — paired with its tool_result below via tool_use_id.
            if (recorder) {
              for (const block of content) {
                if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
                try {
                  const tcId = await beginToolCall({
                    activityId: recorder.activityId,
                    toolName: String(block.name ?? 'unknown'),
                    argsPreview: safeJsonPreview(block.input),
                  });
                  toolUseIdToDbId.set(block.id, tcId);
                } catch (err) {
                  this.log.warn('activity: beginToolCall failed', { error: (err as Error).message });
                }
              }
            }
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
              let resultText: string | null = null;
              if (part.type === 'tool_result' && typeof part.content === 'string' && part.content.length > 0) {
                resultText = part.content;
              } else if (part.type === 'tool_result' && Array.isArray(part.content)) {
                const textParts = part.content.filter((p: any) => p.type === 'text').map((p: any) => p.text);
                if (textParts.length > 0) resultText = textParts.join('');
              }
              if (resultText != null) {
                lastToolResultText = resultText;
                // Finish the matching tool_call db row.
                if (recorder && part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
                  const tcId = toolUseIdToDbId.get(part.tool_use_id);
                  if (tcId) {
                    const status = part.is_error ? 'error' : 'ok';
                    try {
                      await finishToolCall(tcId, status, resultText);
                    } catch (err) {
                      this.log.warn('activity: finishToolCall failed', { error: (err as Error).message });
                    }
                    toolUseIdToDbId.delete(part.tool_use_id);
                  }
                }
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

          if (recorder) {
            const usage = (message as any).usage;
            if (usage) {
              try {
                await recordActivityUsage(recorder.activityId, usage);
              } catch (err) {
                this.log.warn('activity: recordActivityUsage failed', { error: (err as Error).message });
              }
            }
          }

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

      if (statusMsgId) await this.adapter.updateMessage(channelId, statusMsgId, ':white_check_mark:').catch(() => {});
      await this.swapReaction(channelId, messageId, sessionKey, 'white_check_mark');

      if (recorder) await this.closeActivity(recorder.activityId, 'done');

    } catch (error: any) {
      if (error?.name === 'AbortError') {
        this.log.debug('Request aborted', { sessionKey });
        if (statusMsgId) await this.adapter.updateMessage(channelId, statusMsgId, ':stop_button:').catch(() => {});
        await this.swapReaction(channelId, messageId, sessionKey, 'stop_button');
        if (recorder) await this.closeActivity(recorder.activityId, 'error', 'aborted');
      } else {
        this.log.error('Error streaming Claude response', { sessionKey, error: error?.message });
        const errText = error?.message?.startsWith('AUTH_EXPIRED:')
          ? 'Authentication expired. Please run `claude login` on the host.'
          : `Something went wrong: \`${error?.message ?? 'Unknown error'}\``;
        if (statusMsgId) await this.adapter.updateMessage(channelId, statusMsgId, errText).catch(() => {});
        await this.swapReaction(channelId, messageId, sessionKey, 'x');
        if (recorder) await this.closeActivity(recorder.activityId, 'error', error?.message ?? 'unknown error');
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      setTimeout(() => this.currentReactions.delete(sessionKey), 5 * 60 * 1000);
    }
  }

  /**
   * Open a task + activity row for this incoming message. Returns `null` when
   * the feature flag is off or the write fails — callers use the null check
   * to skip all further activity bookkeeping.
   */
  private async openActivity(
    msg: IncomingMessage,
    text: string,
  ): Promise<{ activityId: string } | null> {
    if (!activityDashboardEnabled()) return null;
    const rawPlatform = msg.platform || this.adapter.platform || 'slack';
    if (rawPlatform === 'test') return null;
    const platform = rawPlatform as Platform;
    const threadTs = msg.threadId ?? msg.id;
    // Boss → specialist delegation comes in with the boss's bot_id set on
    // the raw event. Fall back to 'user' when no adapter signal is present.
    const initiatorKind: 'user' | 'agent' =
      (msg.raw as any)?.bot_id || (msg.raw as any)?.app_id ? 'agent' : 'user';

    try {
      let initiatorHandle: string | undefined;
      try {
        initiatorHandle = await this.adapter.getUserDisplayName(msg.userId);
      } catch { /* best effort */ }

      const taskId = await upsertTask({
        platform,
        channelId: msg.channelId,
        threadTs,
        initiatorUserId: msg.userId,
        initiatorHandle,
        initialAgentId: this.agent.id,
        openingPreview: text,
      });
      const activityId = await beginActivity({
        taskId,
        agentId: this.agent.id,
        platform,
        initiatorKind,
        initiatorUserId: msg.userId,
        messageRef: msg.id,
        messagePreview: text,
      });
      return { activityId };
    } catch (err) {
      this.log.warn('activity: openActivity failed', { error: (err as Error).message });
      return null;
    }
  }

  /** Finish an activity — errors here must never interrupt the hot path. */
  private async closeActivity(
    activityId: string,
    status: 'done' | 'error',
    error?: string,
  ): Promise<void> {
    try {
      await finishActivity(activityId, status, error);
    } catch (err) {
      this.log.warn('activity: finishActivity failed', { error: (err as Error).message });
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

  /**
   * Build prompt with sender header + thread context + files.
   *
   * The sender header gives the model a deterministic anchor for user-keyed
   * memory rules (e.g. "when user is U095..., say X"). Without it the sender
   * ID is only visible buried inside past thread-history speaker names, which
   * the model often misses.
   */
  private async buildPrompt(
    userId: string,
    channelId: string,
    threadId: string | undefined,
    userText: string,
    files?: FileAttachment[],
    platform?: string,
  ): Promise<string | ContentBlockParam[]> {
    // Resolve sender display name for the header. Failure is non-fatal — the
    // userId alone is still enough for user-keyed memory rules to match.
    let senderName = userId;
    try {
      senderName = await this.adapter.getUserDisplayName(userId);
    } catch { /* fall back to userId */ }
    const platformTag = platform ? ` · platform ${platform}` : '';
    const senderHeader = `[Sender: ${senderName} (${userId}) · channel ${channelId}${threadId ? ` · thread ${threadId}` : ''}${platformTag}]\n\n`;

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

    // Resolve Slack permalink URLs embedded in the message text (up to 3).
    // Slack encodes links as <https://…|label> or <https://…> in mrkdwn.
    const linkedChunks: string[] = [];
    const resolvedFiles: FileAttachment[] = [];
    if (this.adapter.resolveLinkedMessage) {
      const urls = extractSlackPermalinkUrls(userText);
      for (const url of urls) {
        try {
          const linked = await this.adapter.resolveLinkedMessage(url);
          if (!linked) {
            linkedChunks.push(`[Linked Slack message: ${url} — could not be retrieved. The bot may not be in that channel. Let the user know you cannot access it and ask them to paste the content directly.]`);
            continue;
          }
          if (linked.text) linkedChunks.push(`[Linked message: ${url}]\n${linked.text}`);
          resolvedFiles.push(...linked.files);
        } catch (err) {
          this.log.warn('Failed to resolve linked message', { url, error: err });
        }
      }
    }

    // Download files via adapter — direct attachments + any from linked messages
    const allFiles = [...(files ?? []), ...resolvedFiles];
    const textChunks: string[] = [];
    const binaryBlocks: ContentBlockParam[] = [];

    if (allFiles.length > 0) {
      for (const file of allFiles) {
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

    const allTextChunks = [...linkedChunks, ...textChunks];
    const textPrompt = `${senderHeader}${threadContext}${allTextChunks.length > 0 ? allTextChunks.join('\n\n') + '\n\n' : ''}${userText}`.trim();

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
