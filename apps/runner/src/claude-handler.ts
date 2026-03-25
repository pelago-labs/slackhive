/**
 * @fileoverview Claude Code SDK session manager for a single agent.
 *
 * This is the core integration with the Anthropic Claude Code SDK. Each agent
 * instance gets its own ClaudeHandler which manages:
 *
 * 1. **Session continuity** — Maps Slack threads to Claude Code SDK session IDs.
 *    When a user returns to a thread, the agent resumes the exact conversation.
 *
 * 2. **MCP server wiring** — Passes the agent's assigned MCP servers (from the
 *    platform catalog) to the SDK so the agent can use them as tools.
 *
 * 3. **Tool permissions** — Enforces the agent's allowedTools/deniedTools
 *    configuration from the database.
 *
 * 4. **Streaming** — Yields raw SDK messages for the Slack handler to
 *    progressively update the response message.
 *
 * Architecture note:
 * Each agent has ONE ClaudeHandler instance shared across all its Slack
 * conversations. Sessions are keyed by `{userId}-{channelId}-{threadTs}`.
 *
 * @module runner/claude-handler
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, McpServer, Permission, ConversationSession } from '@slack-agent-team/shared';
import {
  getSession,
  upsertSession,
  cleanupStaleSessions,
  updateAgentSlackUserId,
} from './db';
import { agentLogger } from './logger';
import type { Logger } from 'winston';

/**
 * Maximum session inactivity age before cleanup (30 minutes).
 */
const SESSION_MAX_AGE_MS = 30 * 60 * 1_000;

/**
 * How often to run the session cleanup job (every 10 minutes).
 */
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Manages Claude Code SDK sessions and query streaming for a single agent.
 *
 * Each Slack bot instance (one per agent) has one ClaudeHandler. It translates
 * Slack thread context into Claude Code SDK session resume calls, so every
 * conversation has full continuity across bot restarts.
 *
 * @example
 * const handler = new ClaudeHandler(agent, mcpServers, permissions, workDir);
 * await handler.initialize();
 *
 * for await (const message of handler.streamQuery(prompt, sessionKey)) {
 *   // Handle SDK messages (text, tool_use, system, etc.)
 * }
 */
export class ClaudeHandler {
  private readonly agent: Agent;
  private readonly mcpServers: McpServer[];
  private readonly permissions: Permission | null;
  private readonly workDir: string;
  private readonly log: Logger;

  /** In-memory session cache. Keys are session keys; values are Claude session IDs. */
  private sessionCache: Map<string, string> = new Map();

  /** Cleanup interval handle. */
  private cleanupTimer: NodeJS.Timeout | null = null;

  /**
   * Creates a new ClaudeHandler for an agent.
   *
   * @param {Agent} agent - The agent this handler manages conversations for.
   * @param {McpServer[]} mcpServers - MCP servers assigned to this agent.
   * @param {Permission | null} permissions - Tool permission config, or null for defaults.
   * @param {string} workDir - Path to the agent's temporary workspace (contains CLAUDE.md).
   */
  constructor(
    agent: Agent,
    mcpServers: McpServer[],
    permissions: Permission | null,
    workDir: string
  ) {
    this.agent = agent;
    this.mcpServers = mcpServers;
    this.permissions = permissions;
    this.workDir = workDir;
    this.log = agentLogger(agent.slug);
  }

  /**
   * Starts the periodic session cleanup job.
   * Should be called once after construction.
   *
   * @returns {void}
   */
  initialize(): void {
    this.cleanupTimer = setInterval(
      () => this.runSessionCleanup(),
      SESSION_CLEANUP_INTERVAL_MS
    );
    this.log.debug('ClaudeHandler initialized', { workDir: this.workDir });
  }

  /**
   * Stops the session cleanup timer.
   * Should be called when the agent is stopping.
   *
   * @returns {void}
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessionCache.clear();
  }

  /**
   * Computes the session key for a given Slack conversation context.
   * The key uniquely identifies a conversation: user × channel × thread.
   *
   * @param {string} userId - Slack user ID.
   * @param {string} channelId - Slack channel ID.
   * @param {string} [threadTs] - Thread timestamp, or undefined for top-level messages.
   * @returns {string} Composite session key.
   */
  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs ?? 'direct'}`;
  }

  /**
   * Streams a query to Claude Code SDK, yielding raw SDK messages.
   *
   * Handles session resume automatically: if a session exists for the given
   * key, it passes `options.resume = sessionId` so the agent continues the
   * conversation in context. On the first message in a new session, the SDK
   * returns a `system:init` message with the new session ID, which is then
   * persisted to the database.
   *
   * @param {string} prompt - The user's message to send to Claude.
   * @param {string} sessionKey - Composite session key for this conversation.
   * @param {AbortController} [abortController] - Optional abort controller for cancellation.
   * @yields {SDKMessage} Raw messages from the Claude Code SDK stream.
   * @throws {Error} If the Claude Code SDK query fails.
   *
   * @example
   * const sessionKey = handler.getSessionKey(userId, channelId, threadTs);
   * for await (const msg of handler.streamQuery(prompt, sessionKey)) {
   *   if (msg.type === 'assistant') {
   *     // Progressive update Slack message
   *   }
   * }
   */
  async *streamQuery(
    prompt: string,
    sessionKey: string,
    abortController?: AbortController
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // Resolve existing Claude session ID (in-memory cache first, then DB)
    let claudeSessionId = this.sessionCache.get(sessionKey);
    if (!claudeSessionId) {
      const persisted = await getSession(this.agent.id, sessionKey);
      if (persisted?.claudeSessionId) {
        claudeSessionId = persisted.claudeSessionId;
        this.sessionCache.set(sessionKey, claudeSessionId);
      }
    }

    // Build SDK options
    const options = this.buildSdkOptions(claudeSessionId, abortController);

    this.log.debug('Streaming query', {
      sessionKey,
      resume: claudeSessionId ? 'yes' : 'new',
      mcpServers: this.mcpServers.map((m) => m.name),
    });

    let newSessionId: string | undefined;

    try {
      for await (const message of query({ prompt, options })) {
        // Capture the new session ID from the init message
        if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'init'
        ) {
          newSessionId = (message as { session_id?: string }).session_id;
          if (newSessionId) {
            this.sessionCache.set(sessionKey, newSessionId);
            // Persist immediately so it survives restarts
            await upsertSession(this.agent.id, sessionKey, newSessionId);
            this.log.debug('New session created', { sessionKey, sessionId: newSessionId });
          }
        }

        yield message;
      }
    } catch (error) {
      this.log.error('Claude query failed', { sessionKey, error });
      throw error;
    }

    // Touch last_activity on completion
    await upsertSession(this.agent.id, sessionKey, newSessionId ?? claudeSessionId);
  }

  /**
   * Builds the Claude Code SDK options object for a query.
   * Wires up MCP servers, tool permissions, session resume, and working directory.
   *
   * @param {string | undefined} claudeSessionId - Session ID to resume, or undefined for new session.
   * @param {AbortController | undefined} abortController - Optional abort signal.
   * @returns {Record<string, unknown>} SDK options object.
   */
  private buildSdkOptions(
    claudeSessionId: string | undefined,
    abortController?: AbortController
  ): Record<string, unknown> {
    const options: Record<string, unknown> = {
      // bypassPermissions: tool calls are gated by our explicit allowedTools list
      permissionMode: 'bypassPermissions',
      // Load CLAUDE.md from the agent's temp workspace (skills + memories)
      settingSources: ['project'],
      cwd: this.workDir,
      // Abort signal for cancellation (e.g., user sends new message)
      abortController: abortController ?? new AbortController(),
    };

    // --- Tool Permissions ---
    // Start with the base allowed tools from permissions config.
    // If no permissions are configured, default to read-only (Read tool only).
    const baseAllowed: string[] = this.permissions?.allowedTools?.length
      ? this.permissions.allowedTools
      : ['Read'];

    const denied: string[] = this.permissions?.deniedTools ?? [];

    // Add all tools from configured MCP servers
    const mcpToolPrefixes = this.mcpServers.map((s) => `mcp__${s.name}`);

    options.tools = ['Read']; // Always enable Read for CLAUDE.md and memory files
    options.allowedTools = [...new Set([...baseAllowed, ...mcpToolPrefixes])].filter(
      (tool) => !denied.includes(tool)
    );

    // --- MCP Servers ---
    if (this.mcpServers.length > 0) {
      // Transform McpServer[] into the SDK's mcpServers format:
      // { serverName: { command, args, env } | { type, url, headers } }
      options.mcpServers = Object.fromEntries(
        this.mcpServers.map((server) => [server.name, server.config])
      );

      this.log.debug('MCP servers configured', {
        servers: this.mcpServers.map((s) => s.name),
      });
    }

    // --- Session Resume ---
    if (claudeSessionId) {
      options.resume = claudeSessionId;
    }

    return options;
  }

  /**
   * Runs the periodic session cleanup job.
   * Removes in-memory cache entries for sessions that have expired in the DB.
   * Also triggers DB cleanup for stale sessions.
   *
   * @returns {Promise<void>}
   */
  private async runSessionCleanup(): Promise<void> {
    try {
      const deleted = await cleanupStaleSessions(this.agent.id, SESSION_MAX_AGE_MS);
      if (deleted > 0) {
        this.log.info('Cleaned up stale sessions', { count: deleted });
        // Clear in-memory cache too (safe to rebuild from DB on next access)
        this.sessionCache.clear();
      }
    } catch (error) {
      this.log.warn('Session cleanup failed', { error });
    }
  }
}
