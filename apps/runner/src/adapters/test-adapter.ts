/**
 * @fileoverview Test platform adapter — in-app response preview.
 *
 * Implements {@link PlatformAdapter} but posts nothing to a real platform.
 * Instead, every outgoing payload, reaction, and tool_use block is forwarded
 * through an `emit` callback so the test-panel UI can render them as SSE
 * events. Used by the `/test` endpoint on the runner's internal HTTP server.
 *
 * The adapter is ephemeral: one instance per test session, destroyed when
 * the user resets or navigates away.
 *
 * For multi-agent test sessions (boss delegating to specialists), several
 * TestAdapter instances share a single `ThreadMessage[]` history and route
 * outgoing payloads through a structured `outgoingHook` that the test
 * orchestrator uses to fan out `<@...>` mentions.
 *
 * @module runner/adapters/test-adapter
 */

import type {
  PlatformAdapter, IncomingMessage, ThreadMessage, MessagePayload,
} from '@slackhive/shared';

/** Events the panel understands. One SSE line per event. */
export type TestEvent =
  | { type: 'text';        agent: AgentRef; content: string }
  | { type: 'tool';        agent: AgentRef; name: string; input: unknown }
  | { type: 'reaction';    agent: AgentRef; emoji: string }
  | { type: 'notice';      agent: AgentRef; text: string }
  | { type: 'done' }
  | { type: 'error';       message: string };

/** Identifies which participant emitted an event in a multi-agent session. */
export interface AgentRef {
  id: string;
  name: string;
  /** Platform bot ID (e.g. slackBotUserId) if the agent has one — used by
   *  the UI to rewrite `<@Uxxx>` tokens to `@AgentName` at render time. */
  botUserId?: string;
}

/** Outgoing events the orchestrator hooks to do mention fan-out. Fired
 *  BEFORE the adapter's `emit` runs, so the orchestrator can decide to
 *  short-circuit or annotate. */
export type OutgoingEvent =
  | { kind: 'payload'; text: string }
  | { kind: 'tool'; name: string; input: unknown };

/** Static identifiers for the synthetic test user / channel / thread. */
const TEST_BOT_ID       = 'U-TEST-BOT';
const DEFAULT_USER_ID   = 'U-TEST-USER';
const DEFAULT_USER_NAME = 'You';
const TEST_CHANNEL      = 'C-TEST-CHANNEL';
const TEST_THREAD       = 'T-TEST-THREAD';

export class TestAdapter implements PlatformAdapter {
  readonly platform = 'test';

  private messageHandler?: (msg: IncomingMessage) => Promise<void>;

  /** Accumulated turns in this test session — used by `getThreadMessages`
   *  so multi-turn conversations carry prior context through the same
   *  code path Slack threads use. In a multi-agent session this is a ref
   *  to a single shared array owned by the TeamTestSession so every
   *  participant sees the full thread. */
  private history: ThreadMessage[] = [];

  /** Identity the agent sees for the human side of the chat. Defaults to
   *  a generic "You" but the test handler swaps in the logged-in SlackHive
   *  user's name so user-aware agent logic ("call aman 'boss'") actually
   *  fires in test mode. */
  private userId = DEFAULT_USER_ID;
  private userDisplayName = DEFAULT_USER_NAME;

  /** Orchestrator-supplied hook fired on every outgoing payload BEFORE
   *  the SSE emit. Used to fan out mentions to other participants. */
  private outgoingHook?: (ev: OutgoingEvent) => Promise<void>;

  /** AgentRef stamped onto every SSE event this adapter emits. Set by
   *  the orchestrator when wiring a participant. */
  private agentRef: AgentRef = { id: 'unknown', name: 'Agent' };

  /** Bot ID for this specific participant (used in `getBotUserId` and in
   *  `stripMention` so inbound messages from other participants have the
   *  target's own mention stripped before they hit the model). */
  private botUserId = TEST_BOT_ID;

  constructor(private emit: (ev: TestEvent) => void) {}

  /** Set the effective human user for subsequent turns. `name` is used as
   *  both display name and as the sanitized user ID so per-user memories /
   *  rules that key off IDs still match consistently within a session. */
  setCurrentUser(name: string): void {
    this.userDisplayName = name;
    this.userId = `U-TEST-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  /** Swap the emit target — the runner reuses one adapter across turns but
   *  each POST /test has its own SSE response to stream into. */
  setEmit(emit: (ev: TestEvent) => void): void { this.emit = emit; }

  /** Replace the internal history with a ref to a shared array. Multiple
   *  participants in the same session share one array so every agent sees
   *  the full multi-agent thread via `getThreadMessages`. */
  setSharedHistory(history: ThreadMessage[]): void { this.history = history; }

  /** Register the orchestrator's outgoing hook. Fired BEFORE emit. */
  setOutgoingHook(hook: (ev: OutgoingEvent) => Promise<void>): void {
    this.outgoingHook = hook;
  }

  /** Stamp this adapter with its participant identity for SSE events. */
  setAgentRef(ref: AgentRef): void { this.agentRef = ref; }

  /** Override the default test bot ID — used when a participant represents
   *  a real SlackHive agent so inbound mentions route correctly. */
  setBotUserId(botUserId: string): void { this.botUserId = botUserId; }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> { /* no-op */ }
  async stop(): Promise<void>  { /* no-op */ }
  getBotUserId(): string { return this.botUserId; }

  // ─── Receive ───────────────────────────────────────────────────────

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Feed a user message into the runtime as if it arrived from Slack.
   * Returns the promise from MessageHandler so the SSE caller can await
   * completion and then emit `{ type: 'done' }`.
   */
  async injectMessage(text: string): Promise<void> {
    this.history.push({ userId: this.userId, displayName: this.userDisplayName, text, isBot: false });
    const msg: IncomingMessage = {
      id: `test-msg-${Date.now()}`,
      platform: 'test',
      userId: this.userId,
      channelId: TEST_CHANNEL,
      threadId: TEST_THREAD,
      text,
      isDM: false,
      files: [],
    };
    if (!this.messageHandler) {
      throw new Error('TestAdapter: onMessage handler not registered');
    }
    await this.messageHandler(msg);
  }

  /**
   * Inject a message that appears to come FROM another participant (a boss
   * or specialist agent in the same session), not from the human user.
   * Used by the orchestrator to deliver `<@...>` mentions as if Slack had
   * dispatched them.
   */
  async injectAgentMessage(text: string, fromUserId: string, fromDisplayName: string): Promise<void> {
    this.history.push({ userId: fromUserId, displayName: fromDisplayName, text, isBot: true });
    const msg: IncomingMessage = {
      id: `test-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      platform: 'test',
      userId: fromUserId,
      channelId: TEST_CHANNEL,
      threadId: TEST_THREAD,
      text,
      isDM: false,
      files: [],
    };
    if (!this.messageHandler) {
      throw new Error('TestAdapter: onMessage handler not registered');
    }
    await this.messageHandler(msg);
  }

  // ─── Send — everything routes through `emit` + `outgoingHook` ──────

  async postMessage(_channelId: string, text: string): Promise<string> {
    this.history.push({ userId: this.botUserId, displayName: this.agentRef.name, text, isBot: true });
    // Emit BEFORE the outgoing hook so the UI renders this agent's bubble
    // before any delegated specialist replies that the hook kicks off.
    this.emit({ type: 'text', agent: this.agentRef, content: text });
    if (this.outgoingHook) await this.outgoingHook({ kind: 'payload', text });
    return `test-out-${Date.now()}`;
  }

  async postPayload(_channelId: string, payload: MessagePayload): Promise<string> {
    this.history.push({ userId: this.botUserId, displayName: this.agentRef.name, text: payload.text, isBot: true });
    // Emit BEFORE the outgoing hook so the UI renders this agent's bubble
    // before any delegated specialist replies that the hook kicks off.
    this.emit({ type: 'text', agent: this.agentRef, content: payload.text });
    if (this.outgoingHook) await this.outgoingHook({ kind: 'payload', text: payload.text });
    return `test-out-${Date.now()}`;
  }

  async updateMessage(): Promise<void> { /* MessageHandler uses this for status edits; we ignore. */ }

  async postReaction(_channelId: string, _messageId: string, emoji: string): Promise<void> {
    this.emit({ type: 'reaction', agent: this.agentRef, emoji });
  }

  async removeReaction(): Promise<void> { /* no-op */ }

  async uploadFile(): Promise<void> { /* MVP: drop file uploads silently */ }

  // ─── Context ───────────────────────────────────────────────────────

  async getThreadMessages(_channelId: string, _threadId: string, limit: number): Promise<ThreadMessage[]> {
    // Exclude the current in-flight user message (the last item) from the
    // context window — MessageHandler already prepends it as the sender
    // header. Returning the tail gives the agent previous-turn memory.
    return this.history.slice(0, -1).slice(-limit);
  }

  async getUserDisplayName(userId: string): Promise<string> {
    if (userId === this.botUserId) return this.agentRef.name;
    if (userId === this.userId) return this.userDisplayName;
    // Look up other bots in the shared history so mention → name resolution
    // works across multi-agent sessions.
    const match = this.history.find(m => m.userId === userId && m.displayName);
    return match?.displayName ?? 'You';
  }

  async openDm(): Promise<string> { return TEST_CHANNEL; }

  // ─── Formatting ────────────────────────────────────────────────────
  //
  // No platform-specific rules — test mode shows whatever the agent emits,
  // rendered as standard markdown in the UI. A Telegram/Discord test mode
  // could subclass this and inject its own rules.

  getFormattingRules(): string { return ''; }
  formatMarkdown(md: string): string { return md; }
  buildPayloads(text: string): MessagePayload[] { return [{ text }]; }
  formatMention(userId: string): string { return `<@${userId}>`; }
  stripMention(text: string): string {
    if (!this.botUserId) return text;
    return text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
  }

  /** Matches Slack-style `<@U...>` mentions — which is what boss CLAUDE.md
   *  (generated by boss-registry.ts) emits today. When agents ship on
   *  Telegram/Discord natively, each platform's adapter defines its own. */
  parseMentions(text: string): string[] {
    const out: string[] = [];
    const re = /<@([UW][A-Z0-9]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  async downloadFile(): Promise<Buffer> {
    throw new Error('File downloads are not supported in test mode.');
  }

  // ─── Test-only hook: MessageHandler calls this on assistant messages
  //     that contain tool_use blocks. We piggyback on the opt-in
  //     `formatToolStatus` extension (SlackAdapter also has one) to
  //     surface each tool call as a `{ type: 'tool' }` SSE event. ────

  formatToolStatus(content: unknown[]): string | null {
    for (const block of content as Array<{ type?: string; name?: string; input?: unknown }>) {
      if (block.type === 'tool_use' && block.name) {
        this.emit({ type: 'tool', agent: this.agentRef, name: block.name, input: block.input ?? null });
      }
    }
    return null;
  }
}
