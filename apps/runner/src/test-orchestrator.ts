/**
 * @fileoverview Test-mode delegation orchestrator.
 *
 * Simulates Slack's mention→delivery behaviour inside a single test session
 * so boss agents can delegate to specialists without a real Slack workspace.
 *
 * The flow mirrors how Slack does it: boss emits text containing `<@Uxxx>`;
 * Slack's Events API delivers an `app_mention` to the mentioned bot; the bot
 * reads the thread and replies in the same thread; if the reply mentions the
 * boss, the boss gets woken for a follow-up turn. There is no SlackHive
 * bus — it's entirely text mentions + thread context, and we simulate that.
 *
 * Key invariants:
 *   - Every participant shares the same `ThreadMessage[]` history, so
 *     `getThreadMessages` returns the full multi-bot conversation.
 *   - Mention parsing is an adapter concern — we call `adapter.parseMentions`
 *     so when Telegram/Discord land, their mention grammar is handled by
 *     their respective adapters and this orchestrator is unchanged.
 *   - Depth + fan-out are capped to prevent a model loop from running
 *     forever.
 *
 * @module runner/test-orchestrator
 */

import type { IncomingMessage } from '@slackhive/shared';
import type { TestEvent } from './adapters/test-adapter';
import type { AgentRunner, TeamTestSession, AgentParticipant } from './agent-runner';
import { getAgentBySlackBotUserId } from './db';
import { logger } from './logger';

/** Max number of `<@...>` mentions we'll fan out from a single payload. */
const MAX_FANOUT_PER_PAYLOAD = 3;
/** Max delegation hops per user turn before we bail. */
const MAX_DELEGATION_DEPTH = 6;

const TEST_CHANNEL = 'C-TEST-CHANNEL';
const TEST_THREAD  = 'T-TEST-THREAD';

export class TestOrchestrator {
  /** Hops used in the current user turn. Reset at the top of each runTurn. */
  private depth = 0;

  /** True once we've aborted for depth — suppresses further fan-outs. */
  private aborted = false;

  constructor(
    private runner: AgentRunner,
    private session: TeamTestSession,
    private emitSse: (ev: TestEvent) => void,
  ) {
    this.wireAllParticipants();
  }

  /**
   * Ensure every participant (current + future) calls back into this
   * orchestrator on every outgoing payload. Re-entrant — safe to call
   * whenever a new participant joins.
   */
  private wireAllParticipants(): void {
    for (const p of this.session.participants.values()) {
      this.wireParticipant(p);
    }
  }

  private wireParticipant(p: AgentParticipant): void {
    p.adapter.setEmit(ev => this.emitSse(ev));
    p.adapter.setOutgoingHook(async ev => {
      if (ev.kind === 'payload') {
        await this.onParticipantPayload(p, ev.text);
      }
    });
  }

  /**
   * Run one user turn against the session. Inject into the root participant,
   * then let the adapter's outgoing hook drive fan-out. Emits `{type:'done'}`
   * when the delegation tree settles.
   */
  async runTurn(userMessage: string, userName: string | null): Promise<void> {
    this.depth = 0;
    this.aborted = false;

    const root = this.session.participants.get(this.session.rootAgentId);
    if (!root) throw new Error('test session root participant missing');

    // Apply the user's display name to the root adapter so the model sees
    // a stable identity.
    if (userName) root.adapter.setCurrentUser(userName);

    // Ensure any participants added mid-session are wired — a no-op for
    // already-wired ones.
    this.wireAllParticipants();

    await root.adapter.injectMessage(userMessage);
  }

  /**
   * Hook fired by a participant's adapter BEFORE its SSE emit runs. Scans
   * the outgoing payload for `<@U...>` mentions and dispatches each one
   * to the corresponding participant as an incoming message.
   *
   * If the mention doesn't resolve to a SlackHive agent (human user,
   * unknown ID), it's silently ignored — the payload still renders,
   * the UI annotates it on the client side.
   */
  private async onParticipantPayload(from: AgentParticipant, text: string): Promise<void> {
    if (this.aborted) return;

    const mentions = from.adapter.parseMentions(text);
    if (mentions.length === 0) return;

    // Dedupe (a boss may `<@X>` twice in one message) and drop self-mentions
    // so the model can't trivially loop on itself.
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const id of mentions) {
      if (from.agent.slackBotUserId && id === from.agent.slackBotUserId) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      targets.push(id);
      if (targets.length >= MAX_FANOUT_PER_PAYLOAD) break;
    }
    if (mentions.length > MAX_FANOUT_PER_PAYLOAD) {
      logger.warn('test orchestrator: fan-out cap hit, dropping extras', {
        rootAgentId: this.session.rootAgentId,
        from: from.agent.slug,
        mentions: mentions.length,
      });
    }

    for (const botId of targets) {
      if (this.aborted) return;
      await this.routeMention(from, botId, text);
    }
  }

  /**
   * Resolve `botId` to an agent, lazy-spin a participant, and inject the
   * sender's full message as if Slack had delivered an `app_mention`.
   */
  private async routeMention(from: AgentParticipant, botId: string, text: string): Promise<void> {
    // Depth cap — belt-and-suspenders guard against a model loop.
    if (this.depth >= MAX_DELEGATION_DEPTH) {
      this.aborted = true;
      this.emitSse({ type: 'error', message: 'delegation-depth-exceeded' });
      logger.warn('test orchestrator: delegation depth exceeded', {
        rootAgentId: this.session.rootAgentId,
        sessionId: this.session.sessionId,
      });
      return;
    }

    const target = await getAgentBySlackBotUserId(botId);
    if (!target) {
      // Unknown mention — could be a human user or an agent outside SlackHive.
      // In real Slack this would deliver to a real bot/user; in test mode
      // there's nothing to dispatch to, so surface an inline note under the
      // sender's bubble so the user sees the chain stopped here.
      this.emitSse({
        type: 'notice',
        agent: {
          id: from.agent.id,
          name: from.agent.name,
          botUserId: from.agent.slackBotUserId ?? undefined,
        },
        text: `No agent found for <@${botId}> — would need a real Slack routing to deliver this.`,
      });
      return;
    }

    // Never route to a participant that isn't meant to report into this test
    // session's team. This mirrors Slack's actual behaviour: mentioning a
    // bot that isn't in the channel is a no-op. Here we're strict only on
    // recursion safety — `reportsTo` isn't enforced, because a specialist
    // mentioning the boss is the expected pattern.

    const targetParticipant = await this.runner.ensureParticipant(this.session, target);
    // New participant joined — make sure its adapter is hooked. `wireParticipant`
    // is idempotent.
    this.wireParticipant(targetParticipant);

    this.depth++;

    // Build an IncomingMessage that looks like a Slack app_mention: from the
    // sending bot, in the shared test thread. `stripMention` inside the
    // target's adapter will strip only the target's own `<@>` before
    // the model sees the text, matching Slack behaviour.
    const senderBotId = from.agent.slackBotUserId ?? from.adapter.getBotUserId();
    const msg: IncomingMessage = {
      id: `test-delegate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      platform: 'test',
      userId: senderBotId,
      channelId: TEST_CHANNEL,
      threadId: TEST_THREAD,
      text,
      isDM: false,
      files: [],
    };

    // Record the sender's message in the shared history as a bot message
    // so future turns (including the target's context window) see it. The
    // sender's own postPayload already pushed its text into history, so
    // we DON'T push again here — that would duplicate.

    // Fire the target participant's handler. Its reply will flow back
    // through its adapter → outgoing hook → this orchestrator, enabling
    // the recursion to keep going (boss → spec → boss → …).
    try {
      await targetParticipant.messageHandler.handleMessage(msg);
    } catch (err) {
      logger.error('test orchestrator: delegated turn failed', {
        from: from.agent.slug,
        to: target.slug,
        error: (err as Error).message,
      });
      this.emitSse({
        type: 'error',
        message: `delegation to ${target.name} failed: ${(err as Error).message}`,
      });
    }
  }
}
