/**
 * @fileoverview Generic Slack command handler for agent corrections.
 *
 * Commands use the agent's slug as prefix so any agent can have corrections:
 *   @GILFOYLE gilfoyle:correct "always use UTC"
 *   @GILFOYLE gilfoyle:corrections
 *   @GILFOYLE gilfoyle:corrections remove 3
 *   @GILFOYLE gilfoyle:help
 *
 * Commands are intercepted before normal message processing in slack-handler.ts.
 *
 * Adapted from nlq-claude-slack-bot/src/correction-handler.ts.
 * Key changes: NLQ-specific -> generic per-agent, slug-prefixed commands.
 *
 * @module runner/correction-handler
 */

import type { Agent } from '@slackhive/shared';
import { CorrectionManager } from './correction-manager';
import { agentLogger } from './logger';

const MAX_CORRECTIONS = 30;

interface SlackContext {
  userId: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
}

export class CorrectionHandler {
  private correctionManager: CorrectionManager;
  private agent: Agent;
  private prefix: string;
  private reviewerAllowlist: string[];
  private log;

  constructor(agent: Agent) {
    this.agent = agent;
    this.prefix = `${agent.slug}:`;
    this.correctionManager = new CorrectionManager(agent);
    this.reviewerAllowlist = (process.env.CORRECTION_REVIEWERS || '').split(',').filter(Boolean);
    this.log = agentLogger(agent.slug);
  }

  /**
   * Returns true if the given text is a command for this agent.
   * Checks for `{slug}:correct`, `{slug}:corrections`, or `{slug}:help`.
   */
  isCommand(text: string): boolean {
    return text.startsWith(`${this.prefix}correct`) || text.startsWith(`${this.prefix}help`);
  }

  /**
   * Routes a command to the appropriate handler.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handle(ctx: SlackContext, text: string, client: any): Promise<void> {
    const threadTs = ctx.threadTs ?? ctx.messageTs;
    const slug = this.agent.slug;

    const postReply = async (msg: string) => {
      await client.chat.postMessage({
        channel: ctx.channelId,
        thread_ts: threadTs,
        text: msg,
      });
    };

    // {slug}:help
    if (text === `${this.prefix}help`) {
      await postReply(
        `*${this.agent.name} Commands*\n\n` +
        `\u2022 \`${slug}:correct <text>\` \u2014 Add a correction rule\n` +
        `\u2022 \`${slug}:corrections\` \u2014 View all stored corrections\n` +
        `\u2022 \`${slug}:corrections remove <N>\` \u2014 Remove correction #N\n` +
        `\u2022 \`${slug}:help\` \u2014 Show this help message`
      );
      return;
    }

    // {slug}:corrections (show all)
    if (text === `${this.prefix}corrections` || text === `${this.prefix}correction`) {
      return this.handleShow(postReply);
    }

    // {slug}:corrections remove N
    const removePrefix = `${this.prefix}corrections remove `;
    if (text.startsWith(removePrefix)) {
      const numStr = text.slice(removePrefix.length).trim();
      const num = parseInt(numStr, 10);
      if (isNaN(num) || num < 1) {
        await postReply(`Usage: \`${slug}:corrections remove <number>\``);
        return;
      }
      return this.handleRemove(ctx, num, postReply);
    }

    // {slug}:correct <text>
    const correctPrefix = `${this.prefix}correct `;
    if (text.startsWith(correctPrefix)) {
      const correctionText = text.slice(correctPrefix.length).trim();
      if (!correctionText) {
        await postReply(`Usage: \`${slug}:correct <correction text>\``);
        return;
      }
      return this.handleAdd(ctx, correctionText, client, postReply);
    }

    // Unrecognized {slug}: command
    await postReply(
      `Available commands:\n` +
      `\u2022 \`${slug}:correct <text>\` \u2014 Add a correction\n` +
      `\u2022 \`${slug}:corrections\` \u2014 Show current corrections\n` +
      `\u2022 \`${slug}:corrections remove <N>\` \u2014 Remove correction #N`
    );
  }

  private isAuthorized(userId: string): boolean {
    if (this.reviewerAllowlist.length === 0) return true;
    return this.reviewerAllowlist.includes(userId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchThreadContext(client: any, channelId: string, threadTs: string): Promise<string | undefined> {
    try {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 20,
      });
      const messages: any[] = result.messages ?? [];
      if (messages.length < 2) return undefined;

      const userQuestion = (messages[0].text || '').substring(0, 500);
      const botReplyText = messages[1].text || '';
      const sqlMatch = botReplyText.match(/```sql[\s\S]*?```/);
      const botExcerpt = sqlMatch
        ? sqlMatch[0].substring(0, 800)
        : botReplyText.substring(0, 500);

      return `User question: "${userQuestion}"\nBot answer (excerpt): ${botExcerpt}`;
    } catch (error) {
      this.log.error('Failed to fetch thread context', { error });
      return undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleAdd(ctx: SlackContext, correctionText: string, client: any, postReply: (msg: string) => Promise<void>): Promise<void> {
    if (!this.isAuthorized(ctx.userId)) {
      await postReply("You don't have permission to submit corrections.");
      return;
    }

    this.log.info('Processing correction', { user: ctx.userId, text: correctionText.substring(0, 100) });
    await postReply('_Processing correction..._');

    let threadContext: string | undefined;
    if (ctx.threadTs) {
      threadContext = await this.fetchThreadContext(client, ctx.channelId, ctx.threadTs);
    }

    const result = await this.correctionManager.addCorrection(correctionText, ctx.userId, threadContext);
    const emoji = result.success ? ':white_check_mark:' : ':warning:';
    await postReply(`${emoji} ${result.message}`);
  }

  private async handleShow(postReply: (msg: string) => Promise<void>): Promise<void> {
    const raw = await this.correctionManager.getRaw();

    if (!raw) {
      await postReply('No corrections on file.');
      return;
    }

    const count = await this.correctionManager.getCount();
    await postReply(`*Current Corrections* (${count}/${MAX_CORRECTIONS}):\n\n${raw}`);
  }

  private async handleRemove(ctx: SlackContext, index: number, postReply: (msg: string) => Promise<void>): Promise<void> {
    if (!this.isAuthorized(ctx.userId)) {
      await postReply("You don't have permission to modify corrections.");
      return;
    }

    const result = await this.correctionManager.removeCorrection(index);
    const emoji = result.success ? ':white_check_mark:' : ':warning:';
    await postReply(`${emoji} ${result.message}`);
  }
}
