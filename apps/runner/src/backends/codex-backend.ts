/**
 * @fileoverview OpenAI Codex runtime for a single agent — the `@openai/codex-sdk`
 * counterpart to {@link ClaudeBackend}. Same constructor shape and `AgentBackend`
 * surface; translates Codex thread events into the neutral `BackendMessage` shape
 * that MessageHandler consumes.
 *
 * Parity notes:
 * - Sessions: a Codex *thread id* is stored in the same `sessions.claude_session_id`
 *   column (opaque) and resumed via `resumeThread`.
 * - Workspace: each session dir gets `AGENTS.md` (read natively by Codex) and
 *   `.agents/skills/` (Codex skills); memory writes land in `memory/` where the
 *   backend-agnostic MemoryWatcher already looks.
 * - Permissions: Codex has no per-tool allow/deny list, so SlackHive's allow/deny
 *   + path-scope map onto sandbox + cwd + additionalDirectories + approvalPolicy
 *   ('never') + network toggle. Closest faithful mapping (see codex-config.ts).
 *
 * @module runner/backends/codex-backend
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
// `@openai/codex-sdk` is ESM-only and its package `exports` has no CJS/`default`
// condition, so a static value import fails under the runner's CommonJS+tsx
// runtime (unlike claude-agent-sdk, which ships a `default` export). We load the
// `Codex` class via dynamic import() — tsx preserves it as a real ESM import.
import type { Codex as CodexClient } from '@openai/codex-sdk';
import type { Agent, McpServer, McpStdioConfig, Permission, AgentBackend, BackendMessage, AgentPrompt } from '@slackhive/shared';
import { DEFAULT_CODEX_MODEL } from '@slackhive/shared';
import { getSession, upsertSession, cleanupStaleSessions } from '../db';
import { agentLogger } from '../logger';
import { McpProcessManager } from '../mcp-process-manager.js';
import { buildCodexConfig, buildThreadOptions } from './codex-config';
import { translateEvent, mapUsage, toCodexInput } from './codex-translate';
import type { Logger } from 'winston';

const SESSION_MAX_AGE_MS = 30 * 60 * 1_000;
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1_000;

export class CodexBackend implements AgentBackend {
  readonly backend = 'codex';

  private readonly agent: Agent;
  private readonly mcpServers: McpServer[];
  private readonly permissions: Permission | null;
  private readonly workDir: string;
  private readonly sessionsDir: string;
  private readonly log: Logger;
  private readonly envVarValues: Record<string, string>;
  private readonly apiKey: string | undefined;
  private readonly mcpManager: McpProcessManager;
  private codex: CodexClient | null = null;
  /** Resolves once stdio MCP proxies are up; ensureCodex awaits it. */
  private proxiesReady: Promise<void> | null = null;

  /** In-memory cache: sessionKey → Codex thread id */
  private sessionCache: Map<string, string> = new Map();
  private inflightAborts: Set<AbortController> = new Set();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    agent: Agent,
    mcpServers: McpServer[],
    permissions: Permission | null,
    workDir: string,
    envVarValues: Record<string, string> = {},
  ) {
    this.agent = agent;
    this.mcpServers = mcpServers;
    this.permissions = permissions;
    this.workDir = workDir;
    this.sessionsDir = path.join(workDir, 'sessions');
    this.log = agentLogger(agent.slug);
    this.envVarValues = envVarValues;
    // API key (api-key mode); when absent, Codex uses ~/.codex/auth.json (subscription).
    this.apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || undefined;
    // Shared MCP proxy (same module Claude uses). stdio servers are fronted by a
    // local proxy that connects with empty client capabilities (no elicitation),
    // so eliciting servers work headlessly on Codex — see mcp-process-manager.
    const slugHash = agent.slug.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    this.mcpManager = new McpProcessManager(agent.slug, workDir, 14000 + (slugHash % 200) * 50);
  }

  /** Lazily construct the Codex client via dynamic import (ESM-only package). */
  private async ensureCodex(): Promise<CodexClient> {
    if (!this.codex) {
      if (this.proxiesReady) await this.proxiesReady;
      const { Codex } = await import('@openai/codex-sdk');
      this.codex = new Codex({
        ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
        ...(this.apiKey ? { apiKey: this.apiKey } : {}),
        config: buildCodexConfig(this.mcpServers, this.envVarValues, (name) => this.mcpManager.getStreamableUrl(name)),
      });
    }
    return this.codex;
  }

  /** Start a local proxy for each stdio MCP server (Codex connects via its URL). */
  private async startMcpProxies(): Promise<void> {
    const stdio = this.mcpServers.filter(
      (s) => s.type === 'stdio' || (!('url' in (s.config as object)) && ('command' in (s.config as object))),
    );
    await Promise.all(
      stdio.map((s) =>
        this.mcpManager
          .startServer(s.name, s.config as McpStdioConfig, this.envVarValues)
          .catch((err) => this.log.error('MCP proxy start failed', { server: s.name, error: (err as Error).message })),
      ),
    );
  }

  initialize(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.cleanupTimer = setInterval(() => this.runSessionCleanup(), SESSION_CLEANUP_INTERVAL_MS);
    this.proxiesReady = this.startMcpProxies();
    this.log.info('CodexBackend initialized', {
      workDir: this.workDir,
      mcpServers: this.mcpServers.map((s) => s.name),
    });
  }

  async destroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const ctl of this.inflightAborts) {
      try { ctl.abort(); } catch { /* swallow */ }
    }
    this.inflightAborts.clear();
    this.sessionCache.clear();
    await this.mcpManager.stopAll().catch((err) =>
      this.log.warn('Error stopping MCP proxies', { error: (err as Error).message }),
    );
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs ?? 'direct'}`;
  }

  /**
   * Per-session working dir: AGENTS.md (Codex reads it from cwd) + .agents/skills
   * (Codex skills) copied from the agent root, plus a memory/ dir and knowledge symlink.
   */
  private getSessionWorkDir(sessionKey: string): string {
    const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionDir = path.join(this.sessionsDir, safeName);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });

      // AGENTS.md (canonical instruction doc) — Codex loads it from the cwd.
      const agentDoc = path.join(this.workDir, 'AGENTS.md');
      const legacyDoc = path.join(this.workDir, 'CLAUDE.md');
      const docSrc = fs.existsSync(agentDoc) ? agentDoc : (fs.existsSync(legacyDoc) ? legacyDoc : null);
      if (docSrc) fs.copyFileSync(docSrc, path.join(sessionDir, 'AGENTS.md'));

      // .agents/skills/ — Codex discovers skills here.
      const agentSkills = path.join(this.workDir, '.agents', 'skills');
      if (fs.existsSync(agentSkills)) {
        fs.cpSync(agentSkills, path.join(sessionDir, '.agents', 'skills'), { recursive: true });
      }

      // memory/ — agent-written memories; MemoryWatcher syncs these to the DB.
      fs.mkdirSync(path.join(sessionDir, 'memory'), { recursive: true });
      this.log.debug('Codex session work dir created', { sessionKey, sessionDir });
    }

    // knowledge/ symlink (wiki + sources), idempotent — matches ClaudeBackend.
    const agentKnowledge = path.join(this.workDir, 'knowledge');
    const sessionKnowledge = path.join(sessionDir, 'knowledge');
    if (fs.existsSync(agentKnowledge) && !fs.existsSync(sessionKnowledge)) {
      try { fs.symlinkSync(agentKnowledge, sessionKnowledge, 'dir'); }
      catch (err) { this.log.warn('Failed to symlink knowledge dir', { error: (err as Error).message }); }
    }

    return sessionDir;
  }

  /**
   * Codex model for this agent — taken from `agent.model` (chosen per agent in
   * the web UI). Falls back to a default if the stored model is a Claude id
   * (e.g. an agent created before switching the backend to Codex).
   */
  private getModel(): string {
    const m = this.agent.model;
    return m && !/^claude/i.test(m) ? m : DEFAULT_CODEX_MODEL;
  }

  async *streamQuery(
    prompt: AgentPrompt,
    sessionKey: string,
    abortController?: AbortController,
  ): AsyncGenerator<BackendMessage, void, unknown> {
    const abort = abortController ?? new AbortController();
    this.inflightAborts.add(abort);
    try {
      yield* this.streamQueryInner(prompt, sessionKey, abort);
    } finally {
      this.inflightAborts.delete(abort);
    }
  }

  private async *streamQueryInner(
    prompt: AgentPrompt,
    sessionKey: string,
    abort: AbortController,
  ): AsyncGenerator<BackendMessage, void, unknown> {
    const currentMcpHash = crypto
      .createHash('sha1')
      .update(JSON.stringify(this.mcpServers.map((s) => ({ name: s.name, config: s.config }))))
      .digest('hex');

    // Resolve existing thread id — invalidate if MCP config changed.
    let threadId = this.sessionCache.get(sessionKey);
    if (!threadId) {
      const persisted = await getSession(this.agent.id, sessionKey);
      if (persisted?.claudeSessionId) {
        if (persisted.mcpHash && persisted.mcpHash !== currentMcpHash) {
          this.log.info('MCP config changed, starting fresh Codex thread', { sessionKey });
        } else {
          threadId = persisted.claudeSessionId;
          this.sessionCache.set(sessionKey, threadId);
        }
      }
    }

    const sessionWorkDir = this.getSessionWorkDir(sessionKey);
    const model = this.getModel();
    const threadOptions = buildThreadOptions({
      sessionWorkDir,
      workDir: this.workDir,
      model,
      // Claude agents run with unrestricted network (only curl/wget are command-
      // denied), and MCP servers (e.g. Pelago) need to reach their APIs — a
      // network-sandboxed MCP call surfaces as "user cancelled". So enable network
      // for parity; the workspace-write sandbox still confines the filesystem.
      networkAccess: true,
    });
    const input = toCodexInput(prompt, sessionWorkDir);
    const codex = await this.ensureCodex();

    this.log.debug('Streaming Codex query', {
      sessionKey,
      resume: threadId ? 'yes' : 'new',
      cwd: sessionWorkDir,
      model,
    });

    let retried = false;
    outer: while (true) {
      const thread = threadId
        ? codex.resumeThread(threadId, threadOptions)
        : codex.startThread(threadOptions);

      const startedAt = Date.now();
      const finalParts: string[] = [];

      try {
        const { events } = await thread.runStreamed(input, { signal: abort.signal });
        for await (const event of events) {
          if (abort.signal.aborted) break;
          // Diagnostic: surface MCP tool-call outcomes and turn/stream failures.
          if (event.type === 'item.completed' && (event.item as { type?: string }).type === 'mcp_tool_call') {
            const it = event.item as { server?: string; tool?: string; status?: string; error?: { message?: string } };
            this.log.info('Codex MCP tool call', { server: it.server, tool: it.tool, status: it.status, error: it.error?.message });
          } else if (event.type === 'turn.failed') {
            this.log.warn('Codex turn failed', { error: (event as { error?: { message?: string } }).error?.message });
          } else if (event.type === 'error') {
            this.log.warn('Codex stream error', { message: (event as { message?: string }).message });
          }
          for (const msg of translateEvent(event, finalParts)) {
            // Persist the thread id as soon as it's known.
            if (msg.type === 'system' && msg.session_id) {
              threadId = msg.session_id;
              this.sessionCache.set(sessionKey, threadId);
              await upsertSession(this.agent.id, sessionKey, threadId, currentMcpHash);
            }
            if (msg.type === 'result') {
              (msg as { duration_ms?: number }).duration_ms = Date.now() - startedAt;
            }
            yield msg;
          }
        }
        break; // completed
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Stale thread → retry once as a fresh thread.
        if (!retried && threadId && /thread|session|not found|no conversation/i.test(errMsg)) {
          this.log.warn('Stale Codex thread, retrying as new', { sessionKey, staleThreadId: threadId });
          this.sessionCache.delete(sessionKey);
          threadId = undefined;
          retried = true;
          continue outer;
        }
        this.log.error('Codex query failed', { sessionKey, error: errMsg });
        throw err;
      }
    }

    // Final persist (thread id may have only appeared on thread.id getter).
    const finalId = threadId ?? this.sessionCache.get(sessionKey);
    if (finalId) await upsertSession(this.agent.id, sessionKey, finalId, currentMcpHash);
  }

  private async runSessionCleanup(): Promise<void> {
    try {
      const deleted = await cleanupStaleSessions(this.agent.id, SESSION_MAX_AGE_MS);
      if (deleted > 0) {
        this.log.info('Cleaned up stale Codex sessions', { count: deleted });
        this.sessionCache.clear();
      }
    } catch (error) {
      this.log.warn('Codex session cleanup failed', { error });
    }
  }
}
