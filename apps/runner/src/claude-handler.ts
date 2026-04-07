/**
 * @fileoverview Claude Code SDK session manager for a single agent.
 *
 * Each agent has ONE ClaudeHandler shared across all Slack conversations.
 * Each Slack thread gets its own isolated working directory so Claude's
 * memory files (written to .claude/memory/ inside cwd) are per-thread.
 *
 * Directory layout:
 *   /tmp/agents/{slug}/                  ← agent root (CLAUDE.md lives here)
 *   /tmp/agents/{slug}/sessions/{key}/   ← per-thread cwd
 *     CLAUDE.md                          ← copy of agent CLAUDE.md (skills)
 *     .claude/memory/                    ← per-thread memory files
 *
 * @module runner/claude-handler
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { Agent, McpServer, McpServerConfig, McpStdioConfig, Permission } from '@slackhive/shared';
import {
  getSession,
  upsertSession,
  cleanupStaleSessions,
  upsertMemorySafe,
} from './db';
import { agentLogger } from './logger';
import { parseMemoryFile } from './memory-watcher';
import { McpProcessManager } from './mcp-process-manager.js';
import type { Logger } from 'winston';

const SESSION_MAX_AGE_MS = 30 * 60 * 1_000;
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1_000;

export class ClaudeHandler {
  private readonly agent: Agent;
  private readonly mcpServers: McpServer[];
  private readonly permissions: Permission | null;
  private readonly workDir: string;
  private readonly sessionsDir: string;
  private readonly log: Logger;
  private readonly envVarValues: Record<string, string>;
  private readonly mcpManager: McpProcessManager;

  /** In-memory cache: sessionKey → Claude session ID */
  private sessionCache: Map<string, string> = new Map();

  private cleanupTimer: NodeJS.Timeout | null = null;

  /**
   * @param {Agent} agent - The agent configuration record.
   * @param {McpServer[]} mcpServers - MCP servers assigned to this agent.
   * @param {Permission | null} permissions - Tool allow/deny lists, or null for defaults.
   * @param {string} workDir - Root working directory for this agent (e.g. `/tmp/agents/{slug}`).
   * @param {Record<string, string>} envVarValues - Platform env vars for resolving MCP envRefs.
   */
  constructor(
    agent: Agent,
    mcpServers: McpServer[],
    permissions: Permission | null,
    workDir: string,
    envVarValues: Record<string, string> = {}
  ) {
    this.agent = agent;
    this.mcpServers = mcpServers;
    this.permissions = permissions;
    this.workDir = workDir;
    this.sessionsDir = path.join(workDir, 'sessions');
    this.log = agentLogger(agent.slug);
    this.envVarValues = envVarValues;
    // Allocate a stable port range per agent (14000 + slot * 50)
    const slugHash = agent.slug.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const basePort = 14000 + (slugHash % 200) * 50;
    this.mcpManager = new McpProcessManager(agent.slug, workDir, basePort);
  }

  /**
   * Sets up the sessions directory and starts the periodic stale-session cleanup timer.
   * Must be called once before any `streamQuery` calls.
   *
   * @returns {void}
   */
  initialize(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.cleanupTimer = setInterval(() => this.runSessionCleanup(), SESSION_CLEANUP_INTERVAL_MS);
    this.log.debug('ClaudeHandler initialized', { workDir: this.workDir, sessionsDir: this.sessionsDir });
    // Start persistent MCP proxies for all stdio servers
    this.startMcpProxies().catch((err) =>
      this.log.error('Failed to start MCP proxies', { error: (err as Error).message })
    );
  }

  private async startMcpProxies(): Promise<void> {
    const stdioServers = this.mcpServers.filter(
      (s) => s.type === 'stdio' || (!('url' in (s.config as object)) && ('command' in (s.config as object)))
    );
    await Promise.all(
      stdioServers.map((s) =>
        this.mcpManager
          .startServer(s.name, s.config as McpStdioConfig, this.envVarValues)
          .catch((err) => this.log.error('MCP proxy start failed', { server: s.name, error: (err as Error).message }))
      )
    );
    this.log.info('Agent started', {
      mcpServers: this.mcpServers.map((s) => s.name),
    });
  }

  /**
   * Stops the cleanup timer and clears the in-memory session cache.
   * Called when the agent is stopped or reloaded.
   *
   * @returns {void}
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessionCache.clear();
    this.mcpManager.stopAll().catch(() => {});
  }

  /**
   * Derives a deterministic session key from Slack identifiers.
   * The key is used as both a DB lookup key and a working-directory name.
   *
   * @param {string} userId - Slack user ID (e.g. `U12345678`).
   * @param {string} channelId - Slack channel or DM ID.
   * @param {string} [threadTs] - Thread timestamp; omit for top-level DMs.
   * @returns {string} Composite key: `{userId}-{channelId}-{threadTs|'direct'}`.
   */
  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs ?? 'direct'}`;
  }

  /**
   * Returns the isolated working directory for a session.
   * Creates it on first access and copies CLAUDE.md from the agent root.
   */
  private getSessionWorkDir(sessionKey: string): string {
    // Sanitize key for use as a directory name
    const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionDir = path.join(this.sessionsDir, safeName);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });

      // Copy CLAUDE.md into the session dir so the SDK reads it as project instructions
      const agentClaudeMd = path.join(this.workDir, 'CLAUDE.md');
      if (fs.existsSync(agentClaudeMd)) {
        fs.copyFileSync(agentClaudeMd, path.join(sessionDir, 'CLAUDE.md'));
      }

      // Copy .claude/commands/ (skill slash commands) into the session dir
      const agentCommandsDir = path.join(this.workDir, '.claude', 'commands');
      if (fs.existsSync(agentCommandsDir)) {
        const sessionCommandsDir = path.join(sessionDir, '.claude', 'commands');
        fs.mkdirSync(sessionCommandsDir, { recursive: true });
        for (const file of fs.readdirSync(agentCommandsDir)) {
          fs.copyFileSync(
            path.join(agentCommandsDir, file),
            path.join(sessionCommandsDir, file)
          );
        }
      }

      // Create memory dir for per-thread memory files
      fs.mkdirSync(path.join(sessionDir, '.claude', 'memory'), { recursive: true });
      this.log.debug('Session work dir created', { sessionKey, sessionDir });
    }

    return sessionDir;
  }

  /**
   * Streams a Claude Code SDK query for the given session and yields raw SDK messages.
   *
   * Session resumption: If a Claude session ID exists for this `sessionKey` (in-memory
   * cache or persisted in DB), the query resumes that conversation. On a stale-session
   * error the handler transparently retries once as a fresh session.
   *
   * Callers should check `abortController.signal.aborted` between yields and break early
   * if the user has sent a new message (the Slack handler cancels in-flight requests this way).
   *
   * @param {string} prompt - The user message to send to Claude.
   * @param {string} sessionKey - Session key from {@link getSessionKey}.
   * @param {AbortController} [abortController] - Optional controller to cancel the stream.
   * @yields {SDKMessage} Raw messages from the Claude Code SDK.
   * @throws {Error} On unrecoverable SDK errors (re-thrown after logging).
   */
  async *streamQuery(
    prompt: string | ContentBlockParam[],
    sessionKey: string,
    abortController?: AbortController
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // Resolve existing Claude session ID
    let claudeSessionId = this.sessionCache.get(sessionKey);
    if (!claudeSessionId) {
      const persisted = await getSession(this.agent.id, sessionKey);
      if (persisted?.claudeSessionId) {
        claudeSessionId = persisted.claudeSessionId;
        this.sessionCache.set(sessionKey, claudeSessionId);
      }
    }

    const sessionWorkDir = this.getSessionWorkDir(sessionKey);
    const options = this.buildSdkOptions(sessionWorkDir, claudeSessionId, abortController);

    this.log.debug('Streaming query', {
      sessionKey,
      resume: claudeSessionId ? 'yes' : 'new',
      cwd: sessionWorkDir,
      mcpServers: this.mcpServers.map((m) => m.name),
    });

    let newSessionId: string | undefined;

    // Wrap array content into an AsyncIterable<SDKUserMessage> for multimodal prompts
    const sdkPrompt: string | AsyncIterable<SDKUserMessage> = Array.isArray(prompt)
      ? (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: prompt },
            parent_tool_use_id: null,
          };
        })()
      : prompt;

    // Stream directly for real-time progressive updates.
    // If the session is stale, we catch the error before any messages are yielded
    // and transparently retry as a fresh session.
    const stream = async function* (opts: Record<string, unknown>): AsyncGenerator<SDKMessage> {
      yield* query({ prompt: sdkPrompt, options: opts });
    };

    let activeOptions = options;
    let retried = false;

    outer: while (true) {
      try {
        for await (const message of stream(activeOptions)) {
          if (message.type === 'system' && (message as any).subtype === 'init') {
            newSessionId = (message as any).session_id;
            if (newSessionId) {
              this.sessionCache.set(sessionKey, newSessionId);
              await upsertSession(this.agent.id, sessionKey, newSessionId);
              this.log.debug('Session created', { sessionKey, sessionId: newSessionId, cwd: sessionWorkDir });
            }
          }
          yield message;
        }
        break; // completed successfully
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Retry once on stale session — only if we haven't already retried
        if (!retried && claudeSessionId && (errMsg.includes('No conversation found') || errMsg.includes('session') || errMsg.includes('exited with code 1'))) {
          this.log.warn('Stale session, retrying as new', { sessionKey, staleSessionId: claudeSessionId });
          this.sessionCache.delete(sessionKey);
          claudeSessionId = undefined;
          newSessionId = undefined;
          const freshOptions = { ...activeOptions };
          delete freshOptions.resume;
          activeOptions = freshOptions;
          retried = true;
          continue outer;
        }
        this.log.error('Claude query failed', { sessionKey, error: errMsg });
        throw err;
      }
    }

    await upsertSession(this.agent.id, sessionKey, newSessionId ?? claudeSessionId);
    await this.syncSessionMemories(sessionWorkDir);
  }

  /**
   * Scans the session's .claude/memory/ directory after a query completes and
   * upserts any valid memory files to the database. Belt-and-suspenders alongside
   * the MemoryWatcher to ensure memories are never lost due to missed fs events.
   */
  private async syncSessionMemories(sessionWorkDir: string): Promise<void> {
    const memDir = path.join(sessionWorkDir, '.claude', 'memory');
    if (!fs.existsSync(memDir)) return;

    const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    for (const file of files) {
      const filePath = path.join(memDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseMemoryFile(content);
        if (!parsed) {
          this.log.warn('Memory file has invalid frontmatter, skipping', { file });
          continue;
        }
        await upsertMemorySafe(this.agent.id, parsed.type as 'user' | 'feedback' | 'project' | 'reference', parsed.name, content);
        this.log.info('Memory synced from session', { file, name: parsed.name, type: parsed.type });
      } catch (err) {
        this.log.error('Failed to sync memory file', { file, error: (err as Error).message });
      }
    }
  }

  /**
   * Resolves a raw MCP server config from the DB into one ready for the SDK:
   * - Merges envRefs (references to platform env vars) into the env object
   * - For inline TypeScript MCPs (tsSource): writes the source to disk and
   *   rewrites config to use `tsx <scriptPath>`
   *
   * @param {string} serverName - MCP server name, used for the script filename.
   * @param {McpServerConfig} config - Raw config from the DB.
   * @returns {McpServerConfig} Resolved config safe to pass to the SDK.
   */
  private resolveServerConfig(serverName: string, config: McpServerConfig): McpServerConfig {
    const c = config as McpStdioConfig & Record<string, unknown>;

    if (c.tsSource) {
      const scriptDir = path.join(this.workDir, '.mcp-scripts');
      const scriptPath = path.join(scriptDir, `${serverName}.ts`);
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(scriptPath, c.tsSource as string, 'utf8');
      const resolvedEnv = this.resolveEnvRefs(c);
      return {
        command: '/app/node_modules/.bin/tsx',
        args: [scriptPath],
        env: { NODE_PATH: '/app/node_modules', ...resolvedEnv },
      } as McpServerConfig;
    }

    if (c.envRefs && Object.keys(c.envRefs as object).length > 0) {
      const resolvedEnv = this.resolveEnvRefs(c);
      const { envRefs: _, tsSource: __, ...rest } = c;
      const resolved = { ...rest };
      if (Object.keys(resolvedEnv).length > 0) resolved.env = resolvedEnv;
      return resolved as McpServerConfig;
    }

    return config;
  }

  /**
   * Merges inline env with resolved envRefs into a single env object.
   */
  private resolveEnvRefs(c: McpStdioConfig & Record<string, unknown>): Record<string, string> {
    const merged: Record<string, string> = { ...(c.env ?? {}) };
    const refs = (c.envRefs ?? {}) as Record<string, string>;
    for (const [subKey, storeKey] of Object.entries(refs)) {
      const val = this.envVarValues[storeKey];
      if (val !== undefined) {
        merged[subKey] = val;
      } else {
        this.log.warn('MCP envRef not found in env vars store', { serverName: 'unknown', storeKey, subKey });
      }
    }
    return merged;
  }

  /**
   * Builds the options object passed to the Claude Code SDK `query()` call.
   *
   * Merges agent permissions (allowed/denied tools) with MCP server prefixes
   * so that only explicitly permitted tools are available to the agent.
   * Default allowed tool is `['Read']` when no permissions are configured.
   *
   * @param {string} sessionWorkDir - Per-session working directory path.
   * @param {string | undefined} claudeSessionId - Existing session ID to resume, or undefined for a new session.
   * @param {AbortController} [abortController] - Optional abort controller injected into SDK options.
   * @returns {Record<string, unknown>} Options object for `query({ prompt, options })`.
   */
  private buildSdkOptions(
    sessionWorkDir: string,
    claudeSessionId: string | undefined,
    abortController?: AbortController
  ): Record<string, unknown> {
    const options: Record<string, unknown> = {
      permissionMode: 'acceptEdits',
      settingSources: ['project'],
      cwd: sessionWorkDir,
      abortController: abortController ?? new AbortController(),
    };

    const baseAllowed: string[] = this.permissions?.allowedTools?.length
      ? this.permissions.allowedTools
      : ['Read'];
    const denied: string[] = this.permissions?.deniedTools ?? [];
    const mcpToolPrefixes = this.mcpServers.map((s) => `mcp__${s.name}`);

    options.tools = ['Read'];
    options.allowedTools = [...new Set([...baseAllowed, ...mcpToolPrefixes])].filter(
      (tool) => !denied.includes(tool)
    );

    if (this.mcpServers.length > 0) {
      options.mcpServers = Object.fromEntries(
        this.mcpServers.map((server) => [server.name, this.resolveServerConfig(server.name, server.config)])
      );
      this.log.debug('MCP servers configured', { servers: this.mcpServers.map((s) => s.name) });
    }

    if (claudeSessionId) {
      options.resume = claudeSessionId;
    }

    return options;
  }

  /**
   * Deletes sessions inactive longer than SESSION_MAX_AGE_MS from the DB
   * and clears the in-memory cache so stale IDs are not accidentally reused.
   * Runs on an interval set in {@link initialize}; failures are logged and swallowed.
   *
   * @returns {Promise<void>}
   */
  private async runSessionCleanup(): Promise<void> {
    try {
      const deleted = await cleanupStaleSessions(this.agent.id, SESSION_MAX_AGE_MS);
      if (deleted > 0) {
        this.log.info('Cleaned up stale sessions', { count: deleted });
        this.sessionCache.clear();
      }
    } catch (error) {
      this.log.warn('Session cleanup failed', { error });
    }
  }
}
