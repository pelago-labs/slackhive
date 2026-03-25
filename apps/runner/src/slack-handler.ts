/**
 * @fileoverview Slack event handler for a single agent's Bolt App.
 *
 * Registers all Slack event listeners on a Bolt App instance:
 * - `app_mention` — Bot mentioned in a channel
 * - `message.im` — Direct message to the bot
 * - `member_joined_channel` — Bot added to a new channel
 *
 * For each message, it:
 * 1. Fetches the full thread context (for tagged agents receiving a handoff)
 * 2. Builds the prompt including thread history
 * 3. Streams the Claude Code SDK response
 * 4. Progressively updates a single Slack message as Claude responds
 * 5. Reacts with emoji to show status (🤔 → ⚙️ → ✅)
 *
 * @module runner/slack-handler
 */

import type { App, KnownEventFromType } from '@slack/bolt';
import type { Agent } from '@slack-agent-team/shared';
import type { ClaudeHandler } from './claude-handler';
import { agentLogger } from './logger';
import type { Logger } from 'winston';

/** Maximum number of thread messages to include as context. */
const MAX_THREAD_CONTEXT_MESSAGES = 20;

/** Maximum characters of thread context to include in prompt. */
const MAX_THREAD_CONTEXT_CHARS = 8_000;

/**
 * Registers all Slack event listeners on the given Bolt App for an agent.
 *
 * This function wires the Slack events to the Claude handler. It is called
 * once per agent when the runner starts that agent's Bolt App.
 *
 * @param {App} app - The Bolt App instance for this agent.
 * @param {Agent} agent - The agent configuration.
 * @param {ClaudeHandler} claudeHandler - The Claude Code SDK session manager.
 * @returns {void}
 */
export function registerSlackHandlers(
  app: App,
  agent: Agent,
  claudeHandler: ClaudeHandler
): void {
  const log = agentLogger(agent.slug);

  // Handle @mentions in channels
  app.event('app_mention', async ({ event, client, say }) => {
    await handleMessage({
      app,
      agent,
      claudeHandler,
      client,
      userId: event.user ?? 'unknown',
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      messageTs: event.ts,
      rawText: event.text ?? '',
      log,
    });
  });

  // Handle direct messages
  app.message(async ({ message, client }) => {
    // Only handle direct messages (channel IDs starting with 'D')
    const msg = message as KnownEventFromType<'message'>;
    if (!('channel' in msg) || !msg.channel?.startsWith('D')) return;
    if (!('text' in msg) || !('user' in msg)) return;

    await handleMessage({
      app,
      agent,
      claudeHandler,
      client,
      userId: (msg as { user: string }).user,
      channelId: (msg as { channel: string }).channel,
      threadTs: (msg as { thread_ts?: string }).thread_ts,
      messageTs: (msg as { ts: string }).ts,
      rawText: (msg as { text: string }).text ?? '',
      log,
    });
  });

  // Greet users when the bot joins a new channel
  app.event('member_joined_channel', async ({ event, client }) => {
    // Only react when this bot itself joins
    if (!agent.slackBotUserId || event.user !== agent.slackBotUserId) return;

    try {
      await client.chat.postMessage({
        channel: event.channel,
        text: `👋 Hi! I'm *${agent.name}*. ${agent.description ?? ''}\n\nMention me to get started.`,
      });
    } catch (err) {
      log.warn('Failed to post join greeting', { channel: event.channel, error: err });
    }
  });
}

// =============================================================================
// Core message processing
// =============================================================================

interface HandleMessageOptions {
  app: App;
  agent: Agent;
  claudeHandler: ClaudeHandler;
  client: ReturnType<App['client']['constructor']['prototype']['constructor']>;
  userId: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
  rawText: string;
  log: Logger;
}

/**
 * Processes a single incoming Slack message:
 * 1. Strips bot mentions from the text
 * 2. Fetches thread context if this is a threaded message
 * 3. Streams Claude's response
 * 4. Progressively updates a Slack message with the response
 *
 * @param {HandleMessageOptions} opts - All context needed to process the message.
 * @returns {Promise<void>}
 */
async function handleMessage(opts: HandleMessageOptions): Promise<void> {
  const { app, agent, claudeHandler, client, userId, channelId, threadTs, messageTs, rawText, log } = opts;

  // Strip bot mention from text (e.g., "<@U12345> help" → "help")
  const userText = stripBotMention(rawText, agent.slackBotUserId).trim();
  if (!userText) return; // Ignore empty messages

  const sessionKey = claudeHandler.getSessionKey(userId, channelId, threadTs);

  log.info('Processing message', {
    userId,
    channelId,
    threadTs,
    sessionKey,
    textLength: userText.length,
  });

  // Add thinking reaction to the original message
  try {
    await client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: 'thinking_face',
    });
  } catch { /* Non-fatal */ }

  // Post initial status message
  let statusMessageTs: string | undefined;
  try {
    const posted = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '🤔 Thinking...',
    });
    statusMessageTs = posted.ts as string | undefined;
  } catch (err) {
    log.error('Failed to post initial status message', { error: err });
    return;
  }

  // Build full prompt including thread context for handoffs
  const prompt = await buildPrompt(client, channelId, threadTs, userText, agent, log);

  // Stream the Claude response
  const abortController = new AbortController();
  let fullText = '';
  let toolsInUse: string[] = [];

  try {
    for await (const message of claudeHandler.streamQuery(prompt, sessionKey, abortController)) {
      if (message.type === 'assistant') {
        // Accumulate text content
        for (const block of (message as { content: Array<{ type: string; text?: string }> }).content) {
          if (block.type === 'text' && block.text) {
            fullText += block.text;
          }
          if (block.type === 'tool_use') {
            const toolName = (block as { name?: string }).name ?? 'tool';
            toolsInUse.push(toolName);
          }
        }

        // Progressive update: show partial response as it streams
        if (statusMessageTs && fullText) {
          await updateMessage(client, channelId, statusMessageTs, fullText, log);
        }
      }

      // Show tool usage status
      if (message.type === 'tool_result' && statusMessageTs && toolsInUse.length > 0) {
        const toolDisplay = toolsInUse[toolsInUse.length - 1];
        await updateMessage(
          client,
          channelId,
          statusMessageTs,
          `⚙️ Using \`${toolDisplay}\`...\n\n${fullText}`,
          log
        );
        toolsInUse = [];
      }
    }

    // Final update with complete response
    if (statusMessageTs) {
      const finalText = fullText.trim() || '_No response generated._';
      await updateMessage(client, channelId, statusMessageTs, finalText, log);
    }

    // Update reaction: done ✅
    try {
      await client.reactions.remove({ channel: channelId, timestamp: messageTs, name: 'thinking_face' });
      await client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'white_check_mark' });
    } catch { /* Non-fatal */ }

  } catch (error) {
    log.error('Error streaming Claude response', { sessionKey, error });

    const errorText = `❌ Something went wrong. Please try again.\n\`\`\`${(error as Error).message}\`\`\``;
    if (statusMessageTs) {
      await updateMessage(client, channelId, statusMessageTs, errorText, log);
    }

    try {
      await client.reactions.remove({ channel: channelId, timestamp: messageTs, name: 'thinking_face' });
      await client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'x' });
    } catch { /* Non-fatal */ }
  }
}

// =============================================================================
// Prompt builder
// =============================================================================

/**
 * Builds the full prompt for Claude including thread context.
 *
 * When the boss agent delegates to this agent by tagging it in a thread,
 * the thread contains the full conversation so far (user + boss messages).
 * Including this context means the tagged agent understands exactly what
 * has been discussed without needing to be re-briefed.
 *
 * @param {any} client - Slack Web API client.
 * @param {string} channelId - Slack channel ID.
 * @param {string | undefined} threadTs - Thread timestamp, or undefined.
 * @param {string} userText - The user's current message (stripped of mention).
 * @param {Agent} agent - The agent processing the message.
 * @param {Logger} log - Logger instance.
 * @returns {Promise<string>} The complete prompt string for Claude.
 */
async function buildPrompt(
  client: any,
  channelId: string,
  threadTs: string | undefined,
  userText: string,
  agent: Agent,
  log: Logger
): Promise<string> {
  if (!threadTs) {
    return userText;
  }

  // Fetch thread history to give the agent full context
  let threadContext = '';
  try {
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: MAX_THREAD_CONTEXT_MESSAGES,
    });

    const messages: Array<{ user?: string; bot_id?: string; text: string; ts: string }> =
      replies.messages ?? [];

    // Build context from earlier messages (not the current one)
    const contextMessages = messages.slice(0, -1); // Exclude the triggering message

    if (contextMessages.length > 0) {
      const contextLines = contextMessages.map((m) => {
        const speaker = m.bot_id ? `Assistant (${agent.name})` : `User`;
        const text = stripBotMention(m.text ?? '', agent.slackBotUserId);
        return `${speaker}: ${text}`;
      });

      let context = contextLines.join('\n');
      // Truncate if too long
      if (context.length > MAX_THREAD_CONTEXT_CHARS) {
        context = '...' + context.slice(-MAX_THREAD_CONTEXT_CHARS);
      }

      threadContext = `[Thread context]\n${context}\n\n`;
    }
  } catch (err) {
    log.warn('Failed to fetch thread context', { error: err });
  }

  return `${threadContext}${userText}`;
}

// =============================================================================
// Slack API helpers
// =============================================================================

/**
 * Updates an existing Slack message with new text.
 * Silently ignores update failures to avoid crashing the stream.
 *
 * @param {any} client - Slack Web API client.
 * @param {string} channelId - Channel containing the message.
 * @param {string} ts - Timestamp of the message to update.
 * @param {string} text - New message text.
 * @param {Logger} log - Logger for warnings.
 * @returns {Promise<void>}
 */
async function updateMessage(
  client: any,
  channelId: string,
  ts: string,
  text: string,
  log: Logger
): Promise<void> {
  try {
    await client.chat.update({ channel: channelId, ts, text });
  } catch (err) {
    log.warn('Failed to update message', { ts, error: err });
  }
}

/**
 * Strips a bot mention from the beginning of a Slack message text.
 * Handles the format `<@UXXXXXXXX> rest of message`.
 *
 * @param {string} text - Raw Slack message text.
 * @param {string | undefined} botUserId - The bot's Slack user ID.
 * @returns {string} Text with the bot mention removed.
 */
function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
}
