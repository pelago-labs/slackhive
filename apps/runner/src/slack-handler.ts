/**
 * @fileoverview Slack event handler for a single agent's Bolt App.
 *
 * Key behaviours ported from the kaishen claude-code-slack-bot:
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
import { agentLogger } from './logger';
import type { Logger } from 'winston';

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

export function registerSlackHandlers(
  app: App,
  agent: Agent,
  claudeHandler: ClaudeHandler
): void {
  const log = agentLogger(agent.slug);

  /** Track in-flight abort controllers per session so new messages cancel old ones. */
  const activeControllers = new Map<string, AbortController>();

  /** Track current emoji reaction per session to avoid duplicate add calls. */
  const currentReactions = new Map<string, string>();

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
      app, agent, claudeHandler, client, log,
      activeControllers, currentReactions, updateReaction,
      userId: event.user ?? 'unknown',
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      messageTs: event.ts,
      rawText: event.text ?? '',
    });
  });

  app.message(async ({ message, client }) => {
    const msg = message as KnownEventFromType<'message'>;
    if (!('channel' in msg) || !msg.channel?.startsWith('D')) return;
    if (!('text' in msg) || !('user' in msg)) return;
    await handleMessage({
      app, agent, claudeHandler, client, log,
      activeControllers, currentReactions, updateReaction,
      userId: (msg as any).user,
      channelId: (msg as any).channel,
      threadTs: (msg as any).thread_ts,
      messageTs: (msg as any).ts,
      rawText: (msg as any).text ?? '',
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

interface HandleMessageOpts {
  app: App;
  agent: Agent;
  claudeHandler: ClaudeHandler;
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
}

async function handleMessage(opts: HandleMessageOpts): Promise<void> {
  const { app, agent, claudeHandler, client, log, activeControllers, currentReactions, updateReaction,
    userId, channelId, threadTs, messageTs, rawText } = opts;

  const userText = stripBotMention(rawText, agent.slackBotUserId).trim();
  if (!userText) return;

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

  const prompt = await buildPrompt(client, channelId, threadTs, userText, agent, log);

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
          const payload = buildMessagePayload(textContent, false);
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: payload.text,
            ...(payload.blocks && { blocks: payload.blocks }),
          });
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
            const payload = buildMessagePayload(finalResult, true);
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: payload.text,
              ...(payload.blocks && { blocks: payload.blocks }),
            });
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
      const payload = buildMessagePayload(fallback, true);
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: payload.text,
        ...(payload.blocks && { blocks: payload.blocks }),
      });
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
// Message formatting (ported from kaishen claude-code-slack-bot)
// =============================================================================

/**
 * Builds a Slack message payload. If text contains a markdown table, converts
 * it to a native Slack table block. Otherwise returns formatted plain text.
 *
 * @param {string} text - Raw text from Claude.
 * @param {boolean} isFinal - Whether this is the final message.
 * @returns {{ text: string; blocks?: any[] }} Slack-ready payload.
 */
function buildMessagePayload(text: string, isFinal: boolean): { text: string; blocks?: any[] } {
  const extracted = extractFirstMarkdownTable(text);

  if (!extracted) {
    return { text: formatMessage(text, isFinal) };
  }

  const parsed = parseMarkdownTable(extracted.tableLines);
  if (parsed.headers.length === 0) {
    return { text: formatMessage(text, isFinal) };
  }

  const tableBlock = buildSlackTableBlock(parsed);
  const blocks: any[] = [];

  const beforeText = formatMessage(extracted.before.trim(), false);
  if (beforeText) {
    for (const chunk of splitTextForBlocks(beforeText)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
  }

  blocks.push(tableBlock);

  const afterText = formatMessage(extracted.after.trim(), isFinal);
  if (afterText) {
    for (const chunk of splitTextForBlocks(afterText)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
  }

  return { text: formatMessage(text, isFinal), blocks };
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
function formatMessage(text: string, _isFinal: boolean): string {
  const codeBlocks: string[] = [];
  let formatted = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
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
  formatted = formatted.replace(/__CODE_BLOCK_(\d+)__/g, (_, index) => {
    const block = codeBlocks[parseInt(index)];
    return block.replace(/^```\w+\n/, '```\n');
  });

  return formatted;
}

/** Splits text into ≤3000-char chunks for Slack section blocks. */
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
  const buildRow = (cells: string[]) =>
    parsed.headers.map((_, i) => ({ type: 'raw_text', text: (cells[i] || '').toString() }));
  return {
    type: 'table',
    rows: [buildRow(parsed.headers), ...parsed.rows.slice(0, 99).map(r => buildRow(r))],
    column_settings: parsed.alignments.slice(0, 20).map(a => ({ align: a })),
  };
}

// =============================================================================
// Other helpers
// =============================================================================

function formatToolStatus(content: any[]): string | null {
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

async function buildPrompt(
  client: any, channelId: string, threadTs: string | undefined,
  userText: string, agent: Agent, log: Logger
): Promise<string> {
  if (!threadTs) return userText;

  let threadContext = '';
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

  return `${threadContext}${userText}`;
}

function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
}
