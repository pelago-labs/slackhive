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
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
// `@openai/codex-sdk` is ESM-only and its package `exports` has no CJS/`default`
// condition, so a static value import fails under the runner's CommonJS+tsx
// runtime (unlike claude-agent-sdk, which ships a `default` export). We load the
// `Codex` class via dynamic import() — tsx preserves it as a real ESM import.
import type { Codex as CodexClient } from '@openai/codex-sdk';
import type { Agent, McpServer, McpStdioConfig, Permission, AgentBackend, BackendMessage, AgentPrompt } from '@slackhive/shared';
import { CODEX_MODEL_SETTING_KEY, DEFAULT_CODEX_MODEL, splitCodexModel, type CodexReasoningEffort } from '@slackhive/shared';
import { getSession, upsertSession, deleteSession, cleanupStaleSessions, getSetting } from '../db';
import { agentLogger } from '../logger';
import { McpProcessManager } from '../mcp-process-manager.js';
import { buildCodexConfig, buildThreadOptions, createCodexClient, buildIdentityInstructions, isSessionScopedServer } from './codex-config';
import { translateEvent, mapUsage, toCodexInput } from './codex-translate';
import type { Logger } from 'winston';

const SESSION_MAX_AGE_MS = 30 * 60 * 1_000;
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1_000;

/** Compact one-line preview of a tool's arguments for logs (truncated, secrets are redacted downstream). */
function argPreview(v: unknown): string | undefined {
  if (v == null) return undefined;
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); }
  catch { s = String(v); }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

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
  /** sessionKey → mtime of the agent-root doc last materialized into that session.
   *  Lets getSessionWorkDir skip re-copying AGENTS.md + the skills tree every turn
   *  when the workspace hasn't been recompiled (compile rewrites them together). */
  private lastSyncedDocMtime: Map<string, number> = new Map();
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
      this.codex = await createCodexClient(
        buildCodexConfig(
          this.mcpServers,
          this.envVarValues,
          (name) => this.mcpManager.getStreamableUrl(name),
        ),
        this.apiKey,
        // Forward agent secrets into codex-exec's env so session-scoped MCP servers
        // (written per-session in getSessionWorkDir) can pull them via `env_vars`
        // instead of having their values written into on-disk .codex/config.toml.
        { ...(process.env as Record<string, string>), ...this.envVarValues },
      );
    }
    return this.codex;
  }

  /** Start a local proxy for each stdio MCP server (Codex connects via its URL). */
  private async startMcpProxies(): Promise<void> {
    const stdio = this.mcpServers.filter(
      (s) => !isSessionScopedServer(s) && // session-scoped servers run per-session, not as a shared proxy
        (s.type === 'stdio' || (!('url' in (s.config as object)) && ('command' in (s.config as object)))),
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
      // memory/ — agent-written memories; MemoryWatcher syncs these to the DB.
      fs.mkdirSync(path.join(sessionDir, 'memory'), { recursive: true });
      // git-init so Codex's REPO-scoped skill discovery picks up .agents/skills.
      try { execFileSync('git', ['init', '-q'], { cwd: sessionDir, stdio: 'ignore' }); }
      catch (err) { this.log.warn('git init for Codex skills failed', { error: (err as Error).message }); }
      this.log.debug('Codex session work dir created', { sessionKey, sessionDir });
    }

    // Refresh instructions + skills when the workspace has recompiled, so existing
    // sessions pick up edits/new skills — but skip the (recursive) copies on turns
    // where nothing changed. compileAgentWorkspace rewrites AGENTS.md + the skills
    // trees together, so the doc's mtime is a reliable "workspace changed" signal.
    const agentDoc = path.join(this.workDir, 'AGENTS.md');
    const legacyDoc = path.join(this.workDir, 'CLAUDE.md');
    const docSrc = fs.existsSync(agentDoc) ? agentDoc : (fs.existsSync(legacyDoc) ? legacyDoc : null);
    const docMtime = docSrc ? fs.statSync(docSrc).mtimeMs : 0;
    if (docSrc && this.lastSyncedDocMtime.get(sessionKey) !== docMtime) {
      fs.copyFileSync(docSrc, path.join(sessionDir, 'AGENTS.md'));
      // .agents/skills (Codex native discovery) + skills/ (path-addressable refs).
      for (const rel of [['.agents', 'skills'], ['skills']]) {
        const src = path.join(this.workDir, ...rel);
        const dst = path.join(sessionDir, ...rel);
        if (fs.existsSync(src)) { fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); }
      }
      this.lastSyncedDocMtime.set(sessionKey, docMtime);
    }

    // knowledge/ symlink (wiki + sources), idempotent — matches ClaudeBackend.
    const agentKnowledge = path.join(this.workDir, 'knowledge');
    const sessionKnowledge = path.join(sessionDir, 'knowledge');
    if (fs.existsSync(agentKnowledge) && !fs.existsSync(sessionKnowledge)) {
      try { fs.symlinkSync(agentKnowledge, sessionKnowledge, 'dir'); }
      catch (err) { this.log.warn('Failed to symlink knowledge dir', { error: (err as Error).message }); }
    }

    // Project-scoped .codex/config.toml so Codex spawns session-aware MCP servers
    // (e.g. git) per thread, with their state under this session dir.
    this.writeSessionMcpConfig(sessionDir);

    return sessionDir;
  }

  /**
   * Materialize a project-scoped `.codex/config.toml` in the session dir that
   * registers the agent's session-scoped MCP servers (those reading SESSION_WORK_DIR,
   * e.g. git.ts) with `cwd` + `SESSION_WORK_DIR` = this session. Codex *merges* these
   * with the globally-configured shared servers and spawns one per session, so
   * per-thread state (git clones → `<sessionDir>/repos`) is isolated per thread,
   * matching ClaudeBackend. Secrets ride via `env_vars` (forwarded from codex-exec's
   * env — see ensureCodex), never written into this on-disk file.
   */
  private writeSessionMcpConfig(sessionDir: string): void {
    const scoped = this.mcpServers.filter(isSessionScopedServer);
    if (scoped.length === 0) return;

    // Codex loads a project-scoped .codex/config.toml only for TRUSTED dirs, and
    // trust is honored only from the persisted user config (not --config). Write it
    // proactively — before any codex exec — so the project config loads on the very
    // first turn and Codex never races us to add its own entry.
    this.ensureCodexTrusted(sessionDir);

    // Resolve the tsx runner + NODE_PATH the inline-TS scripts need (same walk the
    // MCP proxy manager uses) so Codex can spawn them directly.
    const nmDirs: string[] = [];
    let cur = path.resolve(__dirname);
    while (cur !== path.dirname(cur)) {
      const nm = path.join(cur, 'node_modules');
      if (fs.existsSync(nm)) nmDirs.push(nm);
      cur = path.dirname(cur);
    }
    const tsxPath = nmDirs.map((nm) => path.join(nm, '.bin', 'tsx')).find((p) => fs.existsSync(p)) ?? 'tsx';
    const nodePath = nmDirs.join(path.delimiter);
    const scriptDir = path.join(this.workDir, '.mcp-scripts');
    fs.mkdirSync(scriptDir, { recursive: true });

    const q = (v: string): string => JSON.stringify(v); // TOML basic string == JSON string for our values
    const blocks: string[] = [];
    for (const s of scoped) {
      const c = s.config as McpStdioConfig & Record<string, unknown>;
      let command = (c.command as string) ?? tsxPath;
      let args = (c.args as string[] | undefined) ?? [];
      if (typeof c.tsSource === 'string') {
        const scriptPath = path.join(scriptDir, `${s.name}.ts`);
        fs.writeFileSync(scriptPath, c.tsSource, 'utf8');
        command = tsxPath;
        args = [scriptPath];
      }
      // env: non-secret knobs written to disk. Secrets ride via env_vars (forwarded).
      const env: Record<string, string> = {
        ...((c.env as Record<string, string>) ?? {}),
        NODE_PATH: nodePath,
        AGENT_SLUG: this.agent.slug,
        SESSION_WORK_DIR: sessionDir,
      };
      const envVars = Object.keys((c.envRefs ?? {}) as Record<string, string>);
      const envInline = Object.entries(env).map(([k, v]) => `${k} = ${q(v)}`).join(', ');
      const lines = [
        `[mcp_servers.${q(s.name)}]`,
        `command = ${q(command)}`,
        `args = [${args.map(q).join(', ')}]`,
        `cwd = ${q(sessionDir)}`,
        `env = { ${envInline} }`,
      ];
      if (envVars.length) lines.push(`env_vars = [${envVars.map(q).join(', ')}]`);
      blocks.push(lines.join('\n'));
    }

    const codexDir = path.join(sessionDir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), blocks.join('\n\n') + '\n', 'utf8');
  }

  /** Add `[projects."<dir>"] trust_level = "trusted"` to the persisted Codex user
   *  config (idempotent) so project-scoped config in that dir is honored. */
  private ensureCodexTrusted(dir: string): void {
    try {
      const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      fs.mkdirSync(codexHome, { recursive: true });
      const cfgPath = path.join(codexHome, 'config.toml');
      const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
      const marker = `[projects.${JSON.stringify(dir)}]`; // matches Codex's own `[projects."/path"]`
      if (existing.includes(marker)) return;
      fs.appendFileSync(cfgPath, `\n${marker}\ntrust_level = "trusted"\n`);
    } catch (err) {
      this.log.warn('Failed to mark Codex session dir trusted', { error: (err as Error).message });
    }
  }

  /**
   * Codex model for this agent. A per-agent Codex model id (agent.model) wins;
   * otherwise the global `codexModel` Settings value; otherwise the default.
   * agent.model holds a Claude id by default (the new-agent wizard has no model
   * picker), so the global setting is what normally applies — read live each turn
   * so a Settings change takes effect on the next message without a reload.
   */
  private async getModel(): Promise<{ model: string; effort?: CodexReasoningEffort }> {
    // Per-agent model wins (unless it still holds the default Claude id); else the
    // global codexModel setting. Either may carry a `:<effort>` reasoning suffix
    // (e.g. gpt-5.5:high) which we split into the model + reasoning effort.
    const stored = (this.agent.model && !/^claude/i.test(this.agent.model))
      ? this.agent.model
      : ((await getSetting(CODEX_MODEL_SETTING_KEY)) ?? DEFAULT_CODEX_MODEL);
    const { model, effort } = splitCodexModel(stored);
    return { model: /^claude/i.test(model) ? DEFAULT_CODEX_MODEL : model, effort };
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
    const { model, effort } = await this.getModel();
    const threadOptions = buildThreadOptions({
      sessionWorkDir,
      workDir: this.workDir,
      model,
      reasoningEffort: effort,
      // Claude agents run with unrestricted network (only curl/wget are command-
      // denied), and MCP servers (e.g. Pelago) need to reach their APIs — a
      // network-sandboxed MCP call surfaces as "user cancelled". So enable network
      // for parity; the workspace-write sandbox still confines the filesystem.
      networkAccess: true,
    });
    let input = toCodexInput(prompt, sessionWorkDir);
    // Persona/identity rides in the prompt itself — Codex's base prompt outranks
    // AGENTS.md and the SDK has no system/developer channel, so this is the one
    // place the model reliably adopts the agent's voice. Prepend every turn.
    const identity = buildIdentityInstructions(this.agent);
    if (identity) {
      if (typeof input === 'string') {
        input = input ? `${identity}\n\n---\n\n${input}` : identity;
      } else {
        input.unshift({ type: 'text', text: identity });
      }
    }
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
      // Per-tool-call start times (keyed by item id) so we can log a duration.
      const toolStart = new Map<string, number>();
      // The precise failure Codex emits as a turn.failed/error event (e.g. a usage
      // limit). The SDK throws a generic "Codex Exec exited with code N" AFTER the
      // stream ends, masking this — so we stash it and prefer it in the catch.
      let turnError: string | undefined;
      // Whether any user-visible (assistant) output was already streamed this
      // attempt — if so we must NOT retry, or the answer would be re-sent.
      let yieldedAny = false;

      try {
        const { events } = await thread.runStreamed(input, { signal: abort.signal });
        for await (const event of events) {
          if (abort.signal.aborted) break;
          // Diagnostic: surface MCP tool-call lifecycle and turn/stream failures.
          if (event.type === 'item.started' && (event.item as { type?: string }).type === 'mcp_tool_call') {
            const it = event.item as { id?: string; server?: string; tool?: string; arguments?: unknown; input?: unknown };
            if (it.id) toolStart.set(it.id, Date.now());
            this.log.info('Tool call started', { server: it.server, tool: it.tool, args: argPreview(it.arguments ?? it.input) });
          } else if (event.type === 'item.completed' && (event.item as { type?: string }).type === 'mcp_tool_call') {
            const it = event.item as { id?: string; server?: string; tool?: string; status?: string; arguments?: unknown; input?: unknown; error?: { message?: string } };
            const durationMs = it.id && toolStart.has(it.id) ? Date.now() - toolStart.get(it.id)! : undefined;
            const level = it.status === 'failed' ? 'warn' : 'info';
            this.log[level]('Tool call finished', { server: it.server, tool: it.tool, status: it.status, durationMs, args: argPreview(it.arguments ?? it.input), error: it.error?.message });
          } else if (event.type === 'item.completed' && (event.item as { type?: string }).type === 'reasoning') {
            // Reasoning isn't posted to Slack (dropped in translateItem) — keep it
            // inspectable here at DEBUG so the Logs tab can still surface it.
            this.log.debug('Codex reasoning', { preview: argPreview((event.item as { text?: string }).text) });
          } else if (event.type === 'turn.failed') {
            turnError = (event as { error?: { message?: string } }).error?.message;
            this.log.warn('Codex turn failed', { error: turnError });
          } else if (event.type === 'error') {
            turnError = (event as { message?: string }).message;
            this.log.warn('Codex stream error', { message: turnError });
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
            if (msg.type === 'assistant') yieldedAny = true;
            yield msg;
          }
        }
        break; // completed
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        // The SDK throws a generic "Codex Exec exited with code N: <stderr>" after
        // the stream ends, even when Codex already reported a precise reason via a
        // turn.failed/error event (usage limit, auth, etc.). Prefer that real reason
        // so logs and Slack show why the turn failed — not just the exit code.
        const errMsg = /exited with (code|signal)/i.test(rawMsg) && turnError ? turnError : rawMsg;
        // Stale thread, or a context overflow that auto-compaction failed to
        // prevent ("ran out of room in the model's context window") → retry once
        // on a fresh thread. For overflow this drops the bloated history so the
        // agent answers the current message instead of getting permanently stuck.
        // Overflow regex is anchored to the real failure phrasings so a generic
        // error/tool message that merely mentions "context window" can't trigger
        // an unwanted reset. Only retry if nothing was streamed yet (else the
        // already-sent answer would be duplicated).
        const isStale = /thread|session|not found|no conversation/i.test(errMsg);
        const isOverflow = /ran out of room|context (window|length) (exceeded|limit)|exceeds? the (model'?s )?(maximum )?context|maximum context length/i.test(errMsg);
        if (!retried && !yieldedAny && threadId && (isStale || isOverflow)) {
          this.log.warn(isOverflow ? 'Codex context overflow — resetting thread and retrying fresh' : 'Stale Codex thread, retrying as new', { sessionKey, staleThreadId: threadId });
          this.sessionCache.delete(sessionKey);
          // Drop the persisted row too so the poisoned thread can't be resumed
          // next turn if this retry also fails before a new id is saved.
          await deleteSession(this.agent.id, sessionKey).catch(() => {});
          threadId = undefined;
          retried = true;
          // On a real overflow the user loses thread history — surface a notice.
          // (Stale-thread resets are benign: the thread was already gone.)
          if (isOverflow) yield { type: 'system', subtype: 'context_reset' } as BackendMessage;
          continue outer;
        }
        this.log.error('Codex query failed', { sessionKey, error: errMsg });
        throw err instanceof Error && errMsg !== rawMsg ? new Error(errMsg) : err;
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
