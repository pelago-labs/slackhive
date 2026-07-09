/**
 * @fileoverview Platform adapter interface for multi-platform agent support.
 *
 * The brain (ClaudeHandler, memory, MCP, wiki) is platform-agnostic.
 * Each messaging platform (Slack, Discord, Telegram, etc.) implements
 * PlatformAdapter to handle receiving/sending messages, formatting,
 * file handling, and platform-specific features.
 *
 * @module @slackhive/shared/platform
 */

// =============================================================================
// Core adapter interface
// =============================================================================

/**
 * Adapter interface that each messaging platform must implement.
 * The agent brain interacts only through this interface — no platform
 * SDK imports leak into the core logic.
 */
export interface PlatformAdapter {
  /** Platform identifier (e.g., 'slack', 'discord', 'telegram'). */
  readonly platform: string;

  // ─── Lifecycle ───────────────────────────────────────────────────

  /** Connect to the platform and start listening for events. */
  start(): Promise<void>;

  /** Gracefully disconnect. */
  stop(): Promise<void>;

  /** Returns the bot's user ID on this platform (discovered after start). */
  getBotUserId(): string | undefined;

  // ─── Receive ─────────────────────────────────────────────────────

  /** Register the message handler. Called once at setup. */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

  // ─── Send ────────────────────────────────────────────────────────

  /** Post a message. Returns the platform message ID. */
  postMessage(channelId: string, text: string, threadId?: string): Promise<string>;

  /** Post a rich payload (text + blocks). Used for formatted responses. */
  postPayload(channelId: string, payload: MessagePayload, threadId?: string): Promise<string>;

  /** Update an existing message (e.g., status updates). */
  updateMessage(channelId: string, messageId: string, text: string): Promise<void>;

  /**
   * Update an existing message with a rich payload (text + blocks). Used to
   * promote a formatted table into an already-posted anchor message — e.g. the
   * job scheduler pre-posts an anchor (so a thread exists during the run) then
   * swaps the headline table into it after the run, so the table is visible
   * in-channel without opening the thread. Adapters that can't update with
   * blocks (e.g. the test adapter) may treat this as a no-op.
   */
  updatePayload(channelId: string, messageId: string, payload: MessagePayload): Promise<void>;

  /** Add a reaction/emoji to a message. */
  postReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  /** Remove a reaction/emoji from a message. */
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * Optional, platform-specific: attach native 👍/👎 feedback controls to the
   * agent's final reply (an already-posted message), so the thumbs render under
   * the answer itself rather than as a separate message. Slack does this by
   * `chat.update`-ing the reply to append a `feedback_buttons` element. The
   * caller passes the reply's id and the payload it was posted with so the
   * adapter can preserve the answer when later swapping the buttons out.
   * Adapters without interactive feedback (e.g. the test adapter) omit this.
   */
  attachFeedbackControls?(channelId: string, messageId: string, payload: MessagePayload, threadId: string | undefined, ctx: { activityId?: string | null }): Promise<void>;

  /** Upload a file to a channel/thread. */
  uploadFile(channelId: string, content: string | Buffer, filename: string, threadId?: string): Promise<void>;

  // ─── Context ─────────────────────────────────────────────────────

  /**
   * Fetch messages in a thread. By default the latest message is excluded — in a
   * live turn that message is the one being replied to (handled separately), so
   * it must not be duplicated into the context. Post-hoc callers (e.g. memory
   * reflection) that need the whole conversation pass `{ includeLatest: true }`.
   */
  getThreadMessages(channelId: string, threadId: string, limit: number, opts?: { includeLatest?: boolean }): Promise<ThreadMessage[]>;

  /** Get a user's display name. */
  getUserDisplayName(userId: string): Promise<string>;

  /** Open a DM channel with a user. Returns the channel ID. */
  openDm(userId: string): Promise<string>;

  // ─── Formatting ──────────────────────────────────────────────────

  /**
   * Returns platform-specific formatting rules to inject into CLAUDE.md.
   * The agent reads these rules and formats its output accordingly.
   *
   * Example (Slack): "Bold: *bold* — NOT **bold**"
   * Example (Discord): "Bold: **bold**"
   */
  getFormattingRules(): string;

  /**
   * Convert standard markdown to platform-native format.
   * Called on Claude's response before posting.
   *
   * Example (Slack): **bold** → *bold*, ## Heading → *Heading*
   * Example (Discord): passthrough (Discord supports standard markdown)
   */
  formatMarkdown(md: string): string;

  /**
   * Build platform-ready message payloads from formatted text.
   * Handles chunking, tables, rich blocks, etc.
   *
   * Implementations MUST honor the {@link PAYLOAD_BREAK} marker: split the text
   * into a new payload at each marker, and strip the marker so it never reaches
   * the user. Adapters with a parent/thread (or message-split) concept thereby
   * let an agent control the boundary explicitly — e.g. keep a leading summary
   * as its own (channel-visible parent) payload while detail tables thread
   * beneath it. Adapters without such a concept may collapse the segments, but
   * must still remove the marker.
   *
   * @param text - Already formatted via formatMarkdown()
   * @param isFinal - Whether this is the final message (vs streaming)
   * @returns Array of payloads (may be >1 if text needs splitting)
   */
  buildPayloads(text: string, isFinal?: boolean): MessagePayload[];

  // ─── Platform-specific (optional) ────────────────────────────────

  /** Leave a channel (e.g., when restricted). Not all platforms support this. */
  leaveChannel?(channelId: string): Promise<void>;

  /**
   * Format a user mention for this platform.
   * Slack: <@U123>, Discord: <@123>, Telegram: @username
   */
  formatMention(userId: string): string;

  /**
   * Strip the bot's own mention from incoming message text.
   * Slack: remove <@BOT_ID>, Discord: remove <@BOT_ID>
   */
  stripMention(text: string): string;

  /**
   * Extract all bot-user mentions from a piece of outgoing agent text.
   * Returns the platform-native user IDs so callers (e.g. the test-mode
   * orchestrator) can look up the target agent without baking platform
   * syntax into higher layers.
   *
   * Example (Slack): "<@U1> please do X" → ["U1"]
   * Example (Telegram): "@alice please do X" → ["alice"]
   */
  parseMentions(text: string): string[];

  /**
   * Download a file from the platform (e.g., Slack file URLs need auth headers).
   * Returns the file content as a Buffer.
   */
  downloadFile(url: string): Promise<Buffer>;

  /**
   * Resolve a linked message URL (e.g. a Slack permalink) into its text and
   * any attached files. Optional — platforms that don't support this return null.
   */
  resolveLinkedMessage?(url: string): Promise<{ text: string; files: FileAttachment[] } | null>;
}

// =============================================================================
// Message types
// =============================================================================

/** Normalized incoming message from any platform. */
export interface IncomingMessage {
  /** Platform-specific message ID. */
  id: string;

  /** Which platform this came from. */
  platform: string;

  /** User who sent the message. */
  userId: string;

  /** Channel/conversation ID. */
  channelId: string;

  /** Thread/reply ID (undefined for top-level messages). */
  threadId?: string;

  /** Message text (with bot mention already stripped). */
  text: string;

  /** Whether this is a direct message (vs channel mention). */
  isDM: boolean;

  /** Attached files. */
  files?: FileAttachment[];

  /** Raw platform event data (escape hatch for platform-specific logic). */
  raw?: unknown;
}

/** A message in thread context (for building conversation history). */
export interface ThreadMessage {
  /** User who sent this message. */
  userId: string;

  /** Platform message id/timestamp (Slack `ts`) — used to match feedback rows. */
  ts?: string;

  /** Display name of the user. */
  displayName?: string;

  /** Message text. */
  text: string;

  /** Whether this was sent by the bot. */
  isBot: boolean;

  /** Attached files. */
  files?: FileAttachment[];
}

/** Normalized file attachment from any platform. */
export interface FileAttachment {
  /** Platform-specific file ID. */
  id: string;

  /** Filename. */
  name: string;

  /** MIME type (e.g., 'text/plain', 'image/png'). */
  mimeType?: string;

  /** File type hint (e.g., 'python', 'csv'). */
  fileType?: string;

  /** File size in bytes. */
  size?: number;

  /** Download URL (may need auth). */
  url?: string;

  /** File content (populated after download). */
  content?: Buffer;
}

/**
 * Author-controlled payload boundary. When an agent emits this marker on its own
 * line, `buildPayloads` ends the current payload and starts a new one there —
 * even where the table/length splitter wouldn't otherwise break. On threading
 * platforms the first payload becomes the channel-visible parent and the rest
 * thread beneath it, so a leading summary can stand alone above its detail
 * tables. It is an HTML comment, so it stays invisible if an adapter ever fails
 * to strip it; adapters MUST split on it and remove it (see {@link PlatformAdapter.buildPayloads}).
 */
export const PAYLOAD_BREAK = '<!--slackhive:break-->';

/** Platform-ready message payload for posting. */
export interface MessagePayload {
  /** Plain text fallback. */
  text: string;

  /** Platform-specific rich content (Block Kit for Slack, Embeds for Discord, etc.). */
  blocks?: unknown[];
}

// =============================================================================
// Platform credentials
// =============================================================================

/** Credentials for connecting to a platform. */
export interface PlatformCredentials {
  platform: string;
  [key: string]: string;
}

/** Slack-specific credentials. */
export interface SlackCredentials extends PlatformCredentials {
  platform: 'slack';
  botToken: string;     // xoxb-...
  appToken: string;     // xapp-...
  signingSecret: string;
}

/** Discord-specific credentials (future). */
export interface DiscordCredentials extends PlatformCredentials {
  platform: 'discord';
  botToken: string;
}

/** Telegram-specific credentials (future). */
export interface TelegramCredentials extends PlatformCredentials {
  platform: 'telegram';
  botToken: string;
}
