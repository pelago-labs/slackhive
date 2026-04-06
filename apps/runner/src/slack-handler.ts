/**
 * @fileoverview Slack event handler for a single agent's Bolt App.
 *
 * Key behaviours:
 * - Abort/cancel: new message in same thread cancels the in-flight request
 * - Tool status: shows friendly "Querying Redshift…" live in the status message
 * - Fallback text: uses lastAssistantText if no messages were sent during stream
 * - result message: extracts final result from SDK result.subtype === 'success'
 * - Reaction cycling: thinking_face → gear → white_check_mark / x
 * - Markdown→Slack formatting: **bold** → *bold*, headings, tables, code blocks
 * - Block Kit: tables rendered as native Slack table blocks with section chunks
 *
 * @module runner/slack-handler
 */

import type { App, KnownEventFromType } from '@slack/bolt';
import type { Agent } from '@slackhive/shared';
import type { ClaudeHandler } from './claude-handler';
import { CorrectionHandler } from './correction-handler';
import { agentLogger } from './logger';
import type { Logger } from 'winston';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

const MAX_THREAD_CONTEXT_MESSAGES = 20;
const MAX_THREAD_CONTEXT_CHARS = 8_000;

/** Friendly labels shown in the status message while a tool is running. */
const MCP_TOOL_LABELS: Record<string, string> = {
  'mcp__redshift-mcp__query': 'Querying Redshift',
  'mcp__redshift-mcp__describe_table': 'Inspecting table structure',
  'mcp__redshift-mcp__find_column': 'Searching for columns',
  'mcp__mcp-server-openmetadata-PRD__search_entities': 'Searching metadata catalog',
  'mcp__mcp-server-openmetadata-PRD__suggest_entities': 'Looking up suggestions',
  'mcp__mcp-server-openmetadata-PRD__get_table_by_name': 'Getting table details',
  'mcp__mcp-server-openmetadata-PRD__get_table': 'Getting table details',
  'mcp__mcp-server-openmetadata-PRD__list_tables': 'Listing tables',
  'mcp__mcp-server-openmetadata-PRD__get_metric': 'Getting metric definition',
  'mcp__mcp-server-openmetadata-PRD__get_metric_by_name': 'Getting metric definition',
  'mcp__mcp-server-openmetadata-PRD__list_metrics': 'Listing metrics',
  'mcp__mcp-server-openmetadata-PRD__get_glossary': 'Getting glossary',
  'mcp__mcp-server-openmetadata-PRD__get_glossary_by_name': 'Getting glossary',
  'mcp__mcp-server-openmetadata-PRD__list_glossaries': 'Listing glossaries',
  'mcp__mcp-server-openmetadata-PRD__get_glossary_term': 'Getting glossary term',
  'mcp__mcp-server-openmetadata-PRD__list_glossary_terms': 'Listing glossary terms',
  'mcp__mcp-server-openmetadata-PRD__get_schema': 'Getting schema info',
  'mcp__mcp-server-openmetadata-PRD__get_schema_by_name': 'Getting schema info',
  'mcp__mcp-server-openmetadata-PRD__list_schemas': 'Listing schemas',
  'mcp__mcp-server-openmetadata-PRD__get_database': 'Getting database info',
  'mcp__mcp-server-openmetadata-PRD__get_database_by_name': 'Getting database info',
  'mcp__mcp-server-openmetadata-PRD__list_databases': 'Listing databases',
  'mcp__mcp-server-openmetadata-PRD__get_lineage': 'Getting data lineage',
  'mcp__mcp-server-openmetadata-PRD__get_lineage_by_name': 'Getting data lineage',
  'mcp__mcp-server-openmetadata-PRD__search_field_query': 'Searching fields',
  'mcp__mcp-server-openmetadata-PRD__search_aggregate': 'Searching aggregations',
  'mcp__mcp-server-openmetadata-PRD__get_tag': 'Getting tag info',
  'mcp__mcp-server-openmetadata-PRD__get_tag_by_name': 'Getting tag info',
  'mcp__mcp-server-openmetadata-PRD__list_tags': 'Listing tags',
  'mcp__mcp-server-openmetadata-PRD__get_classification': 'Getting classification',
  'mcp__mcp-server-openmetadata-PRD__list_classifications': 'Listing classifications',
  'mcp__mcp-server-openmetadata-PRD__get_usage_by_entity': 'Getting usage stats',
  'mcp__mcp-server-openmetadata-PRD__get_entity_usage_summary': 'Getting usage summary',
  'mcp__mcp-server-openmetadata-PRD__get_data_quality_report': 'Getting data quality report',
};

/**
 * Registers all Slack event handlers for a single agent's Bolt App.
 *
 * Handles:
 * - `app_mention` — responds when mentioned in a channel
 * - `message` — responds to direct messages
 * - `member_joined_channel` — posts a welcome message when added to a channel
 *
 * @param {App} app - The Slack Bolt App instance for this agent.
 * @param {Agent} agent - The agent configuration record.
 * @param {ClaudeHandler} claudeHandler - The Claude SDK session manager.
 * @returns {void}
 */
export function registerSlackHandlers(
  app: App,
  agent: Agent,
  claudeHandler: ClaudeHandler
): void {
  const log = agentLogger(agent.slug);
  const correctionHandler = new CorrectionHandler(agent);

  /** Track in-flight abort controllers per session so new messages cancel old ones. */
  const activeControllers = new Map<string, AbortController>();

  /** Track current emoji reaction per session to avoid duplicate add calls. */
  const currentReactions = new Map<string, string>();

  /**
   * Swaps the emoji reaction on a message without leaving duplicate reactions.
   * Removes the current reaction (if any) before adding the new one.
   * Failures are silently ignored as reactions are non-critical UI feedback.
   *
   * @param {WebClient} client - Slack Web API client.
   * @param {string} channelId - Slack channel ID.
   * @param {string} messageTs - Timestamp of the message to react to.
   * @param {string} sessionKey - Session key used to track current reaction.
   * @param {string} emoji - Emoji name to set (without colons).
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function updateReaction(
    client: any,
    channelId: string,
    messageTs: string,
    sessionKey: string,
    emoji: string
  ) {
    const current = currentReactions.get(sessionKey);
    if (current === emoji) return;
    try {
      if (current) {
        await client.reactions.remove({ channel: channelId, timestamp: messageTs, name: current }).catch(() => {});
      }
      await client.reactions.add({ channel: channelId, timestamp: messageTs, name: emoji });
      currentReactions.set(sessionKey, emoji);
    } catch { /* non-fatal */ }
  }

  app.event('app_mention', async ({ event, client }) => {
    await handleMessage({
      app, agent, claudeHandler, correctionHandler, client, log,
      activeControllers, currentReactions, updateReaction,
      userId: event.user ?? 'unknown',
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      messageTs: event.ts,
      rawText: event.text ?? '',
      files: (event as any).files ?? [],
    });
  });

  app.message(async ({ message, client }) => {
    const msg = message as KnownEventFromType<'message'>;
    if (!('channel' in msg) || !msg.channel?.startsWith('D')) return;
    if (!('user' in msg)) return;
    await handleMessage({
      app, agent, claudeHandler, correctionHandler, client, log,
      activeControllers, currentReactions, updateReaction,
      userId: (msg as any).user,
      channelId: (msg as any).channel,
      threadTs: (msg as any).thread_ts,
      messageTs: (msg as any).ts,
      rawText: (msg as any).text ?? '',
      files: (msg as any).files ?? [],
    });
  });

  app.event('member_joined_channel', async ({ event, client }) => {
    if (!agent.slackBotUserId || event.user !== agent.slackBotUserId) return;
    try {
      await client.chat.postMessage({
        channel: event.channel,
        text: `👋 Hi! I'm *${agent.name}*. ${agent.description ?? ''}\n\nMention me to get started.`,
      });
    } catch { /* non-fatal */ }
  });
}

// =============================================================================
// Core message handler
// =============================================================================

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  url_private_download?: string;
  size?: number;
}

interface HandleMessageOpts {
  app: App;
  agent: Agent;
  claudeHandler: ClaudeHandler;
  correctionHandler: CorrectionHandler;
  client: any;
  log: Logger;
  activeControllers: Map<string, AbortController>;
  currentReactions: Map<string, string>;
  updateReaction: (client: any, channelId: string, messageTs: string, sessionKey: string, emoji: string) => Promise<void>;
  userId: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
  rawText: string;
  files?: SlackFile[];
}

async function handleMessage(opts: HandleMessageOpts): Promise<void> {
  const { app, agent, claudeHandler, correctionHandler, client, log, activeControllers, currentReactions, updateReaction,
    userId, channelId, threadTs, messageTs, rawText, files } = opts;

  const userText = stripBotMention(rawText, agent.slackBotUserId).trim();
  if (!userText && (!files || files.length === 0)) return;

  // Route correction/help commands before normal processing
  // Commands use agent slug prefix: {slug}:correct, {slug}:corrections, {slug}:help
  if (correctionHandler.isCommand(userText)) {
    await correctionHandler.handle(
      { userId, channelId, threadTs, messageTs },
      userText,
      client,
    );
    return;
  }

  const sessionKey = claudeHandler.getSessionKey(userId, channelId, threadTs);

  log.info('Processing message', { userId, channelId, threadTs, sessionKey, textLength: userText.length });

  // Abort any in-flight request for this session (user sent a new message)
  activeControllers.get(sessionKey)?.abort();
  const abortController = new AbortController();
  activeControllers.set(sessionKey, abortController);

  // Thinking reaction + initial status message
  await updateReaction(client, channelId, messageTs, sessionKey, 'thinking_face');

  let statusTs: string | undefined;
  try {
    const posted = await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '*Thinking...*' });
    statusTs = posted.ts as string | undefined;
  } catch (err) {
    log.error('Failed to post status message', { error: err });
    return;
  }

  const prompt = await buildPrompt(client, channelId, threadTs, userText, agent, log, files);

  let sentMessages: string[] = [];
  let lastAssistantText: string | null = null;
  let lastToolResultText: string | null = null;

  try {
    for await (const message of claudeHandler.streamQuery(prompt, sessionKey, abortController)) {
      if (abortController.signal.aborted) break;

      if (message.type === 'assistant') {
        const content: any[] = (message as any).message?.content ?? [];
        const hasToolUse = content.some((b: any) => b.type === 'tool_use');

        // Extract text blocks
        const textContent = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (textContent) lastAssistantText = textContent;

        if (hasToolUse) {
          // Show live tool status in the status message
          await updateReaction(client, channelId, messageTs, sessionKey, 'gear');
          const toolStatus = formatToolStatus(content);
          if (statusTs && toolStatus) {
            await client.chat.update({ channel: channelId, ts: statusTs, text: toolStatus }).catch(() => {});
          }
        } else if (textContent) {
          // Text-only assistant message — send immediately
          sentMessages.push(textContent);

          // Extract code blocks for file upload, send text without them
          const { textWithoutCode, codeBlocks } = extractCodeBlocks(textContent);
          const displayText = codeBlocks.length > 0 ? textWithoutCode.trim() : textContent;

          if (displayText) {
            for (const payload of buildMessagePayloads(displayText, false)) {
              await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: payload.text,
                ...(payload.blocks && { blocks: payload.blocks }),
              });
            }
          }

          // Upload code blocks as downloadable file snippets
          if (codeBlocks.length > 0) {
            await uploadCodeSnippets(client, codeBlocks, channelId, threadTs);
          }
        }
      } else if (message.type === 'user') {
        // Capture tool result text for fallback
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
        log.info('Query completed', {
          cost: (message as any).total_cost_usd,
          duration_ms: (message as any).duration_ms,
          status: (message as any).subtype,
          num_turns: (message as any).num_turns,
        });

        if ((message as any).subtype === 'success') {
          const finalResult = (message as any).result as string | undefined;
          if (finalResult && !sentMessages.includes(finalResult)) {
            sentMessages.push(finalResult);

            // Extract code blocks for file upload
            const { textWithoutCode, codeBlocks } = extractCodeBlocks(finalResult);
            const displayText = codeBlocks.length > 0 ? textWithoutCode.trim() : finalResult;

            if (displayText) {
              for (const payload of buildMessagePayloads(displayText, true)) {
                await client.chat.postMessage({
                  channel: channelId,
                  thread_ts: threadTs,
                  text: payload.text,
                  ...(payload.blocks && { blocks: payload.blocks }),
                });
              }
            }

            // Upload code blocks as downloadable file snippets
            if (codeBlocks.length > 0) {
              await uploadCodeSnippets(client, codeBlocks, channelId, threadTs);
            }
          }
        }
      }
    }

    // Fallback: if Claude produced no messages, use lastAssistantText or tool result
    if (sentMessages.length === 0) {
      const fallback = lastAssistantText ?? lastToolResultText ?? '_No response generated._';
      log.info('No messages sent, using fallback', {
        source: lastAssistantText ? 'lastAssistantText' : lastToolResultText ? 'lastToolResultText' : 'default',
      });
      for (const payload of buildMessagePayloads(fallback, true)) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: payload.text,
          ...(payload.blocks && { blocks: payload.blocks }),
        });
      }
    }

    // Update status message to Done and set ✅ reaction
    if (statusTs) {
      await client.chat.update({ channel: channelId, ts: statusTs, text: '*Done*' }).catch(() => {});
    }
    await updateReaction(client, channelId, messageTs, sessionKey, 'white_check_mark');

  } catch (error: any) {
    if (error?.name === 'AbortError') {
      log.debug('Request aborted', { sessionKey });
      if (statusTs) await client.chat.update({ channel: channelId, ts: statusTs, text: '*Cancelled*' }).catch(() => {});
      await updateReaction(client, channelId, messageTs, sessionKey, 'stop_button');
    } else {
      log.error('Error streaming Claude response', { sessionKey, error: error?.message });
      const errText = `❌ Something went wrong. Please try again.\n\`${error?.message ?? 'Unknown error'}\``;
      if (statusTs) await client.chat.update({ channel: channelId, ts: statusTs, text: errText }).catch(() => {});
      await updateReaction(client, channelId, messageTs, sessionKey, 'x');
    }
  } finally {
    activeControllers.delete(sessionKey);
    setTimeout(() => currentReactions.delete(sessionKey), 5 * 60 * 1000);
  }
}

// =============================================================================
// Message formatting
// =============================================================================

/**
 * Builds one or more Slack message payloads from Claude's response text.
 * Each markdown table gets its own payload because Slack only supports
 * one native table block per message.
 *
 * @param {string} text - Raw text from Claude.
 * @param {boolean} isFinal - Whether this is the final message.
 * @returns {{ text: string; blocks?: any[] }[]} Array of Slack-ready payloads.
 */
export function buildMessagePayloads(text: string, isFinal: boolean): { text: string; blocks?: any[] }[] {
  const payloads: { text: string; blocks?: any[] }[] = [];
  let remaining = text;

  while (remaining.trim()) {
    const extracted = extractFirstMarkdownTable(remaining);

    if (!extracted) {
      payloads.push({ text: formatMessage(remaining, isFinal) });
      break;
    }

    const parsed = parseMarkdownTable(extracted.tableLines);
    if (parsed.headers.length === 0) {
      payloads.push({ text: formatMessage(remaining, isFinal) });
      break;
    }

    const blocks: any[] = [];
    const beforeText = formatMessage(extracted.before.trim(), false);
    if (beforeText) {
      for (const chunk of splitTextForBlocks(beforeText)) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      }
    }
    blocks.push(buildSlackTableBlock(parsed));

    const fallback = formatMessage(
      extracted.before.trim() + '\n' + extracted.tableLines.join('\n'),
      false,
    );
    payloads.push({ text: fallback, blocks });

    remaining = extracted.after;
  }

  return payloads.length > 0 ? payloads : [{ text: formatMessage(text, isFinal) }];
}

/**
 * Formats markdown text for Slack mrkdwn:
 * - Preserves code blocks as-is (strips language hints)
 * - Converts headings → *bold*
 * - Removes HR lines
 * - **bold** → *bold*
 * - __italic__ → _italic_
 * - Auto-wraps bare markdown tables in code blocks
 */
export function formatMessage(text: string, _isFinal: boolean): string {
  const codeBlocks: string[] = [];
  // Use a placeholder that cannot be matched by the __italic__ regex.
  // \x00 is not present in normal text and breaks the /__([^_]+)__/ pattern.
  let formatted = text.replace(/```[\s\S]*?```/g, (match) => {
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

  // Restore code blocks (strip language hints)
  formatted = formatted.replace(/\x00CB(\d+)\x00/g, (_, index) => {
    const block = codeBlocks[parseInt(index)];
    return block.replace(/^```\w+\n/, '```\n');
  });

  return formatted;
}

/** Splits text into ≤3000-char chunks for Slack section blocks. */
export function splitTextForBlocks(text: string): string[] {
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

export function isSeparatorLine(line: string): boolean {
  return /^\s*\|?[-:\s|]+\|?\s*$/.test(line) && line.includes('-');
}

export function extractFirstMarkdownTable(text: string): { before: string; tableLines: string[]; after: string } | null {
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

export function parseMarkdownTable(lines: string[]): { headers: string[]; rows: string[][]; alignments: ('left' | 'center' | 'right')[] } {
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

export function buildSlackTableBlock(parsed: { headers: string[]; rows: string[][]; alignments: ('left' | 'center' | 'right')[] }): Record<string, any> {
  const buildRow = (cells: string[]) =>
    parsed.headers.map((_, i) => ({ type: 'raw_text', text: (cells[i] || '').toString() }));
  return {
    type: 'table',
    rows: [buildRow(parsed.headers), ...parsed.rows.slice(0, 99).map(r => buildRow(r))],
    column_settings: parsed.alignments.slice(0, 20).map(a => ({ align: a })),
  };
}

// =============================================================================
// Code snippet uploads
// =============================================================================

/**
 * Strips all non-ASCII characters from code content.
 * Prevents invisible Unicode characters from breaking copy-pasted queries.
 *
 * Ported from nlq-claude-slack-bot/src/slack-handler.ts:890
 */
function sanitizeCodeContent(code: string): string {
  return code.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

/**
 * Extracts fenced code blocks from text, returning text without code blocks
 * and the extracted blocks separately.
 *
 * Ported from nlq-claude-slack-bot/src/slack-handler.ts:898
 */
function extractCodeBlocks(text: string): { textWithoutCode: string; codeBlocks: { lang: string; code: string }[] } {
  const codeBlocks: { lang: string; code: string }[] = [];
  const textWithoutCode = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || 'sql', code: code.trim() });
    return '';
  });
  return { textWithoutCode, codeBlocks };
}

/**
 * Uploads code blocks as Slack file snippets for clean copy-paste.
 * Sanitizes content to remove invisible Unicode characters.
 *
 * Ported from nlq-claude-slack-bot/src/slack-handler.ts:910
 *
 * @param client - Slack Web API client
 * @param codeBlocks - Extracted code blocks with language and content
 * @param channelId - Channel to upload to
 * @param threadTs - Thread timestamp for threading the upload
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function uploadCodeSnippets(
  client: any,
  codeBlocks: { lang: string; code: string }[],
  channelId: string,
  threadTs?: string,
): Promise<void> {
  for (let i = 0; i < codeBlocks.length; i++) {
    const { lang, code } = codeBlocks[i];
    const sanitized = sanitizeCodeContent(code);
    const extension = lang === 'sql' ? 'sql' : (lang || 'txt');
    const name = codeBlocks.length === 1
      ? `query.${extension}`
      : `query_${i + 1}.${extension}`;
    try {
      await client.filesUploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        content: sanitized,
        filename: name,
        title: name,
      });
    } catch {
      // Non-fatal — code is still visible inline in the message
    }
  }
}

// =============================================================================
// Other helpers
// =============================================================================

/**
 * Builds a human-readable status string for the first tool_use block in a
 * Claude assistant message. Used to keep the user informed while a tool runs.
 *
 * Returns a Slack mrkdwn string like `*Querying Redshift*\n\`\`\`sql\n...\n\`\`\``
 * for known tools, `*Working...*` for unknown tools, or null if no tool block.
 *
 * @param {unknown[]} content - The `content` array from a Claude assistant message.
 * @returns {string | null} Slack-formatted status text, or null if no tool was used.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatToolStatus(content: any[]): string | null {
  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    const label = MCP_TOOL_LABELS[block.name];
    if (label) {
      if (block.name === 'mcp__redshift-mcp__query' && block.input?.sql) {
        const sql = String(block.input.sql).slice(0, 500);
        return `*${label}*\n\`\`\`sql\n${sql}\n\`\`\``;
      }
      if (block.input?.query) return `*${label}:* \`${String(block.input.query).slice(0, 100)}\``;
      if (block.input?.fqn || block.input?.name) return `*${label}:* \`${block.input.fqn ?? block.input.name}\``;
      return `*${label}...*`;
    }
    return `*Working...*`;
  }
  return null;
}

/**
 * Builds the full prompt to send to Claude by prepending thread context.
 *
 * Fetches the preceding messages in the thread (up to MAX_THREAD_CONTEXT_MESSAGES)
 * and prefixes them as `[Thread context]` so Claude can follow the conversation.
 * Silently falls back to the bare user text if the Slack API call fails.
 *
 * @param {unknown} client - Slack Web API client.
 * @param {string} channelId - Channel containing the thread.
 * @param {string | undefined} threadTs - Thread timestamp, or undefined for non-thread DMs.
 * @param {string} userText - The user's message with bot mentions stripped.
 * @param {Agent} agent - The agent (used for speaker labelling in context).
 * @param {Logger} log - Logger instance.
 * @param {SlackFile[]} [files] - Files attached to the message.
 * @returns {Promise<string | ContentBlockParam[]>} Prompt for `claudeHandler.streamQuery`.
 */

/** Max bytes to read from a single text file (512 KB). */
const MAX_TEXT_FILE_BYTES = 512 * 1024;
/** Max bytes to download for image/PDF files (20 MB). */
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

const IMAGE_MIMETYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

const IMAGE_FILETYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function getFileKind(file: SlackFile): 'text' | 'image' | 'pdf' | 'unsupported' {
  const mt = file.mimetype ?? '';
  const ft = (file.filetype ?? '').toLowerCase();
  if (mt === 'application/pdf' || ft === 'pdf') return 'pdf';
  if (mt in IMAGE_MIMETYPES || ft in IMAGE_FILETYPES) return 'image';
  if (TEXT_MIMETYPES.has(mt) || mt.startsWith('text/') || TEXT_FILETYPES.has(ft)) return 'text';
  return 'unsupported';
}

async function fetchSlackFile(client: any, url: string): Promise<ArrayBuffer> {
  const token: string = (client as any).token ?? (client as any)._token ?? '';
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

export async function downloadFile(
  client: any,
  file: SlackFile,
  log: Logger
): Promise<{ kind: 'text'; content: string } | { kind: 'block'; block: ContentBlockParam } | null> {
  const kind = getFileKind(file);
  if (kind === 'unsupported') {
    log.debug('Skipping unsupported file type', { name: file.name, mimetype: file.mimetype, filetype: file.filetype });
    return null;
  }
  if (!file.url_private_download) return null;

  const label = file.name ?? file.title ?? file.id;

  try {
    if (kind === 'text') {
      if (file.size && file.size > MAX_TEXT_FILE_BYTES) {
        log.warn('Text file too large, truncating', { name: file.name, size: file.size });
      }
      const buffer = await fetchSlackFile(client, file.url_private_download);
      let text = new TextDecoder().decode(buffer.slice(0, MAX_TEXT_FILE_BYTES));
      if (buffer.byteLength > MAX_TEXT_FILE_BYTES) text += '\n[... truncated at 512 KB ...]';
      return { kind: 'text', content: `[File: ${label}]\n${text}` };
    }

    if (file.size && file.size > MAX_BINARY_FILE_BYTES) {
      log.warn('Binary file too large to send to Claude', { name: file.name, size: file.size });
      return { kind: 'text', content: `[File "${label}" is too large to process (${Math.round((file.size ?? 0) / 1024 / 1024)} MB, limit 20 MB)]` };
    }

    const buffer = await fetchSlackFile(client, file.url_private_download);
    const base64 = Buffer.from(buffer).toString('base64');

    if (kind === 'image') {
      const mt = file.mimetype ?? '';
      const ft = (file.filetype ?? '').toLowerCase();
      const mediaType = IMAGE_MIMETYPES[mt] ?? IMAGE_FILETYPES[ft] ?? 'image/jpeg';
      return {
        kind: 'block',
        block: {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        } as ContentBlockParam,
      };
    }

    return {
      kind: 'block',
      block: {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        title: label,
      } as ContentBlockParam,
    };
  } catch (err) {
    log.warn('Error downloading file', { name: file.name, error: err });
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildPrompt(
  client: any, channelId: string, threadTs: string | undefined,
  userText: string, agent: Agent, log: Logger,
  files?: SlackFile[]
): Promise<string | ContentBlockParam[]> {
  // Fetch thread context
  let threadContext = '';
  if (threadTs) {
    try {
      const replies = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: MAX_THREAD_CONTEXT_MESSAGES });
      const messages: any[] = replies.messages ?? [];
      const contextMessages = messages.slice(0, -1);
      if (contextMessages.length > 0) {
        let context = contextMessages.map((m: any) => {
          const speaker = m.bot_id ? `Assistant (${agent.name})` : 'User';
          return `${speaker}: ${stripBotMention(m.text ?? '', agent.slackBotUserId)}`;
        }).join('\n');
        if (context.length > MAX_THREAD_CONTEXT_CHARS) context = '...' + context.slice(-MAX_THREAD_CONTEXT_CHARS);
        threadContext = `[Thread context]\n${context}\n\n`;
      }
    } catch (err) {
      log.warn('Failed to fetch thread context', { error: err });
    }
  }

  // Download files — split into text chunks and binary blocks
  const textChunks: string[] = [];
  const binaryBlocks: ContentBlockParam[] = [];

  if (files && files.length > 0) {
    const results = await Promise.all(files.map(f => downloadFile(client, f, log)));
    for (const result of results) {
      if (!result) continue;
      if (result.kind === 'text') textChunks.push(result.content);
      else binaryBlocks.push(result.block);
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

/**
 * Removes `<@BOT_USER_ID>` mention tokens from a message string.
 *
 * @param {string} text - Raw Slack message text.
 * @param {string} [botUserId] - The bot's Slack user ID. No-op if undefined.
 * @returns {string} Text with all bot mention tokens stripped and trimmed.
 */
export function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
}
