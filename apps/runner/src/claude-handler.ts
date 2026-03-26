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
import * as path from 'path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, McpServer, Permission } from '@slackhive/shared';
import {
  getSession,
  upsertSession,
  cleanupStaleSessions,
} from './db';
import { agentLogger } from './logger';
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

  /** In-memory cache: sessionKey → Claude session ID */
  private sessionCache: Map<string, string> = new Map();

  private cleanupTimer: NodeJS.Timeout | null = null;

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
    this.sessionsDir = path.join(workDir, 'sessions');
    this.log = agentLogger(agent.slug);
  }

  initialize(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.cleanupTimer = setInterval(() => this.runSessionCleanup(), SESSION_CLEANUP_INTERVAL_MS);
    this.log.debug('ClaudeHandler initialized', { workDir: this.workDir, sessionsDir: this.sessionsDir });
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessionCache.clear();
  }

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
      // Copy CLAUDE.md (agent skills) into the session dir so the SDK picks it up
      const agentClaudeMd = path.join(this.workDir, 'CLAUDE.md');
      if (fs.existsSync(agentClaudeMd)) {
        fs.copyFileSync(agentClaudeMd, path.join(sessionDir, 'CLAUDE.md'));
      }
      // Create memory dir for per-thread memory files
      fs.mkdirSync(path.join(sessionDir, '.claude', 'memory'), { recursive: true });
      this.log.debug('Session work dir created', { sessionKey, sessionDir });
    }

    return sessionDir;
  }

  async *streamQuery(
    prompt: string,
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

    // Stream directly for real-time progressive updates.
    // If the session is stale, we catch the error before any messages are yielded
    // and transparently retry as a fresh session.
    const stream = async function* (opts: Record<string, unknown>): AsyncGenerator<SDKMessage> {
      yield* query({ prompt, options: opts });
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
        if (!retried && claudeSessionId && (errMsg.includes('No conversation found') || errMsg.includes('session'))) {
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
  }

  private buildSdkOptions(
    sessionWorkDir: string,
    claudeSessionId: string | undefined,
    abortController?: AbortController
  ): Record<string, unknown> {
    const options: Record<string, unknown> = {
      permissionMode: 'default',
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
        this.mcpServers.map((server) => [server.name, server.config])
      );
      this.log.debug('MCP servers configured', { servers: this.mcpServers.map((s) => s.name) });
    }

    if (claudeSessionId) {
      options.resume = claudeSessionId;
    }

    return options;
  }

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
