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

  /** Add a reaction/emoji to a message. */
  postReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  /** Remove a reaction/emoji from a message. */
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  /** Upload a file to a channel/thread. */
  uploadFile(channelId: string, content: string | Buffer, filename: string, threadId?: string): Promise<void>;

  // ─── Context ─────────────────────────────────────────────────────

  /** Fetch preceding messages in a thread for conversation context. */
  getThreadMessages(channelId: string, threadId: string, limit: number): Promise<ThreadMessage[]>;

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
