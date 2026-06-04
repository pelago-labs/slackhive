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
import * as crypto from 'crypto';
import { query, type SDKMessage, type SDKUserMessage, type HookCallback, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { Agent, McpServer, McpServerConfig, McpServerType, McpStdioConfig, Permission, AgentBackend, BackendMessage, AgentPrompt } from '@slackhive/shared';
import {
  getSession,
  upsertSession,
  cleanupStaleSessions,
} from '../db';
import { agentLogger } from '../logger';
import { McpProcessManager } from '../mcp-process-manager.js';
import { findProcessesByEnv, killProcessesGracefully } from '../process-utils.js';
import type { Logger } from 'winston';

const SESSION_MAX_AGE_MS = 30 * 60 * 1_000;
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1_000;
const COOPERATIVE_SHUTDOWN_GRACE_MS = 1_000;
const FORCE_KILL_GRACE_MS = 2_000;

/**
 * Platform-wide deny list applied whenever an agent has any Bash permission.
 *
 * This is **defense-in-depth, not a hard boundary.** Patterns match the
 * literal command string the model emits, so a determined model can bypass
 * via runtime expansion (`$HOME`, `$(whoami)`), relative paths after `cd`,
 * or interpreter-mediated reads (e.g. `python3 -c "open('/home/admin/.aws/credentials').read()"`
 * with `Bash(python3 *)` in the allow baseline). True isolation requires
 * per-agent OS users or containers — see the platform isolation issue.
 *
 * What this catches:
 *   - Host CLIs that auto-load identity from local config (gh, aws, kubectl, …)
 *   - Direct DB access (could read SlackHive's own data.db)
 *   - Reads of host secret paths (~/.ssh, ~/.aws, ~/.config/gh, etc.) when the
 *     model uses the literal tilde or absolute /home/admin form
 *   - Process / sys introspection (/proc, /sys — env vars, mounts)
 *   - Global package installs that escape the per-session scope
 *   - Cross-clone into other agents' or system paths
 *   - Shell-escape commands that defeat glob pattern matching (eval, bash -c)
 *   - Cross-agent reads under the agents tree (existing rule, kept)
 *   - Already-banned destructive ops (rm, chmod, sudo, kill, curl, wget)
 *
 * The SDK applies deny patterns ahead of allow patterns, so an operator
 * granting `Bash(pip install *)` cannot accidentally re-enable
 * `Bash(pip install --user *)` here.
 *
 * @param {string} agentsBaseDir - Parent directory containing all agent workdirs.
 * @returns {string[]} Bash(pattern) strings to add to settings.permissions.deny.
 */
export function buildBashDenyBaseline(agentsBaseDir: string): string[] {
  return [
    // Host CLIs that auto-load identity from local config
    'Bash(gh *)', 'Bash(aws *)', 'Bash(kubectl *)', 'Bash(ssh *)',
    'Bash(scp *)', 'Bash(rsync *)', 'Bash(helm *)', 'Bash(terraform *)',
    'Bash(docker *)', 'Bash(doctl *)', 'Bash(gcloud *)', 'Bash(az *)',

    // Direct DB access (could read SlackHive's own data.db or any DB the host can reach)
    'Bash(sqlite3 *)', 'Bash(psql *)', 'Bash(mysql *)', 'Bash(mongosh *)', 'Bash(redis-cli *)',

    // Host-secret file reads — match any command touching these paths.
    'Bash(* ~/.config/*)', 'Bash(* ~/.aws/*)', 'Bash(* ~/.ssh/*)',
    'Bash(* ~/.kube/*)', 'Bash(* ~/.npmrc*)', 'Bash(* ~/.netrc*)',
    'Bash(* /home/admin/.ssh/*)', 'Bash(* /home/admin/.aws/*)',
    'Bash(* /home/admin/.config/*)', 'Bash(* /home/admin/.kube/*)',

    // Env file reads (covers .env, .env.local, etc.) and env-var dumps.
    // `Bash(env*)` (not `Bash(env)`) catches `env | grep AUTH_SECRET`, `env -0`, etc.
    'Bash(cat *.env*)', 'Bash(* .env*)', 'Bash(env*)', 'Bash(printenv*)',

    // Process / sys introspection — these expose env vars, mounts, kernel state
    'Bash(* /proc/*)', 'Bash(* /sys/*)',

    // Global package installs (escape per-session scope)
    'Bash(npm install -g *)', 'Bash(npm install*-g*)',
    'Bash(npm i -g *)', 'Bash(npm i*-g*)',
    'Bash(yarn global *)', 'Bash(pnpm add -g *)', 'Bash(pnpm i -g *)',
    'Bash(pip install --user *)', 'Bash(pip3 install --user *)',
    'Bash(pip install*--user*)', 'Bash(pip3 install*--user*)',
    'Bash(pip install -t /home/*)', 'Bash(pip install -t /usr/*)',
    'Bash(pip3 install -t /home/*)', 'Bash(pip3 install -t /usr/*)',
    'Bash(uv tool install *)',

    // Cross-clone into other agents' or system paths
    'Bash(git clone * /home/*)', 'Bash(git clone * /etc/*)', 'Bash(git clone * /usr/*)',
    `Bash(git clone * ${agentsBaseDir}/*)`,

    // `go install` writes to $GOPATH/bin (~/go/bin) outside the session scope —
    // belt-and-suspenders alongside the narrowed go-subcommand allow list below.
    'Bash(go install *)',

    // Shell-escape — these embed arbitrary commands inside a string and defeat
    // glob pattern matching. Without this an agent could route any blocked
    // command via `bash -c "<blocked>"`.
    'Bash(eval *)', 'Bash(bash -c *)', 'Bash(sh -c *)', 'Bash(zsh -c *)',
    'Bash(* | bash)', 'Bash(* | sh)',

    // Cross-agent reads under the agents tree (existing rules preserved)
    `Bash(cat ${agentsBaseDir}/*)`, `Bash(ls ${agentsBaseDir}/*)`,
    `Bash(find ${agentsBaseDir}/*)`, `Bash(grep * ${agentsBaseDir}/*)`,
    `Bash(python3 ${agentsBaseDir}/*)`, `Bash(python3 -m pytest ${agentsBaseDir}/*)`,
    `Bash(pytest ${agentsBaseDir}/*)`, `Bash(git -C ${agentsBaseDir}/*)`,
    `Bash(git log ${agentsBaseDir}/*)`,

    // Destructive ops + network exfil (existing rules preserved)
    'Bash(rm *)', 'Bash(chmod *)', 'Bash(sudo *)', 'Bash(kill *)',
    'Bash(curl *)', 'Bash(wget *)',
  ];
}

/**
 * Platform-wide allow baseline for common dev / test / read commands operating
 * inside the agent's own session scope. Operator-specified Bash patterns are
 * layered on top of this so existing per-agent permissions still work; the
 * baseline just ensures every Bash-enabled agent has a safe minimum even when
 * the operator hasn't enumerated patterns (e.g. plain "Bash" in allowed_tools).
 *
 * Commands here write to cwd (= sessionWorkDir) by default — the deny baseline
 * blocks the scope-escape variants (`-g`, `--user`, etc.).
 *
 * @param {string} workDir - Agent's compile-time workdir (CLAUDE.md, knowledge/, …).
 * @param {string} sessionWorkDir - Per-session cwd for this thread.
 * @returns {string[]} Bash(pattern) strings to add to settings.permissions.allow.
 */
export function buildBashAllowBaseline(workDir: string, sessionWorkDir: string): string[] {
  return [
    // Read-only file ops within agent scope
    `Bash(ls ${sessionWorkDir}/*)`, `Bash(ls ${sessionWorkDir})`,
    `Bash(cat ${sessionWorkDir}/*)`, `Bash(find ${sessionWorkDir}/*)`,
    `Bash(grep * ${sessionWorkDir}/*)`, `Bash(head ${sessionWorkDir}/*)`,
    `Bash(tail ${sessionWorkDir}/*)`,
    `Bash(ls ${workDir}/*)`, `Bash(cat ${workDir}/*)`,
    `Bash(grep * ${workDir}/*)`, `Bash(find ${workDir}/*)`,

    // Trivially safe utilities
    'Bash(echo *)', 'Bash(pwd)', 'Bash(date)', 'Bash(whoami)',
    'Bash(true)', 'Bash(false)', 'Bash(jq *)', 'Bash(yq *)',
    'Bash(wc *)', 'Bash(sort *)', 'Bash(uniq *)', 'Bash(cut *)',

    // Git — clone into cwd, status, log, diff, branch ops. The deny list
    // blocks `git clone * /home/*` so cross-host clones can't slip through.
    'Bash(git clone *)', 'Bash(git status)', 'Bash(git log *)', 'Bash(git diff *)',
    'Bash(git show *)', 'Bash(git branch *)', 'Bash(git checkout *)',
    'Bash(git fetch *)', 'Bash(git pull *)', 'Bash(git add *)', 'Bash(git commit *)',
    'Bash(git push *)',

    // Node ecosystem — installs go to ./node_modules, deny blocks -g.
    'Bash(npm install *)', 'Bash(npm install)', 'Bash(npm test *)', 'Bash(npm test)',
    'Bash(npm run *)', 'Bash(npm exec *)', 'Bash(npm ci)',
    'Bash(npx *)', 'Bash(yarn *)', 'Bash(pnpm *)',
    'Bash(node *)', 'Bash(ts-node *)', 'Bash(tsx *)',

    // Python ecosystem — installs go to active venv or ./.venv, deny blocks --user / -t /home.
    'Bash(python3 *)', 'Bash(python *)',
    'Bash(pip install *)', 'Bash(pip3 install *)',
    'Bash(pip *)', 'Bash(pip3 *)', 'Bash(uv *)',

    // Test runners — these read/write within the project under cwd.
    'Bash(pytest *)', 'Bash(pytest)', 'Bash(python3 -m pytest *)',
    'Bash(vitest *)', 'Bash(npx vitest *)',
    'Bash(jest *)', 'Bash(npx jest *)',

    // Go — narrowed to subcommands that write/read in cwd. `go install` writes
    // to ~/go/bin (outside scope) and is explicitly denied above.
    'Bash(go test *)', 'Bash(go build *)', 'Bash(go run *)',
    'Bash(go mod *)', 'Bash(go vet *)', 'Bash(go fmt *)',

    // Make — Makefile lives in cwd, so the agent can only invoke targets the
    // operator's own Makefile defines. `make install` would only write outside
    // scope if such a target exists in the cloned repo's Makefile.
    'Bash(make *)',
  ];
}

/**
 * Decides whether a Read / Write / Edit tool call against `filePath` is
 * inside the agent's scope (workDir or sessionWorkDir). Same threat model
 * as the Bash baseline above: the SDK Read tool, by default, can read any
 * file the host OS user can read — including `~/.config/gh/hosts.yml`,
 * `~/.aws/credentials`, `/proc/<runner-pid>/environ`, the slackhive .env,
 * and the slackhive data.db.
 *
 * Policy:
 *   - Allow paths inside the agent's own workDir or sessionWorkDir.
 *     This covers wiki, knowledge sources, slash commands, CLAUDE.md,
 *     per-session memory, scratch files. Wiki access stays working — the
 *     wiki is materialized to `${workDir}/knowledge/wiki/` at compile time.
 *   - Deny everything else. There's no legitimate workflow today where an
 *     agent needs to read a host file outside its own scope; coordination
 *     happens via Slack and MCPs, not shared host files.
 *
 * Same defense-in-depth caveat as the Bash baseline: a determined model
 * with the Bash tool can still bypass via interpreter escapes (python -c,
 * node -e). True isolation needs per-agent OS users / containers.
 *
 * @param filePath The file path the model wants to read/write/edit.
 * @param workDir Agent's compile-time workdir.
 * @param sessionWorkDir Per-session cwd.
 * @returns `null` if allowed, or a string explaining why it was denied.
 */
export function checkPathInAgentScope(
  filePath: string | undefined,
  workDir: string,
  sessionWorkDir: string,
): string | null {
  if (!filePath || typeof filePath !== 'string') {
    // Unknown shape — be conservative and deny so the model has to retry
    // with a properly-formed call rather than slipping through.
    return 'no file path provided';
  }
  // Resolve relative paths against sessionWorkDir (cwd) and to absolute.
  const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(sessionWorkDir, filePath);

  const inWorkDir = abs === workDir || abs.startsWith(workDir + path.sep);
  const inSession = abs === sessionWorkDir || abs.startsWith(sessionWorkDir + path.sep);
  if (inWorkDir || inSession) return null;

  return `path is outside agent scope (workDir=${workDir}, sessionWorkDir=${sessionWorkDir}): ${abs}`;
}

/**
 * Builds a PreToolUse hook callback that blocks Read / Write / Edit calls
 * outside the agent's scope. Registered into the SDK's hooks system so it
 * fires regardless of `permissionMode` (which would otherwise auto-accept
 * file ops under `acceptEdits`).
 *
 * Returns `{ decision: 'block', ... }` to deny, or no-op to allow.
 *
 * @param workDir Agent's compile-time workdir.
 * @param sessionWorkDir Per-session cwd.
 * @param logger Optional logger for emitting deny events (helps audit who tried what).
 */
export function buildPreToolUsePathScopeHook(
  workDir: string,
  sessionWorkDir: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): HookCallback {
  const SCOPED_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const pre = input as PreToolUseHookInput;
    if (!SCOPED_TOOLS.has(pre.tool_name)) return {};

    const toolInput = (pre.tool_input ?? {}) as { file_path?: string; notebook_path?: string };
    const filePath = toolInput.file_path ?? toolInput.notebook_path;
    const denyReason = checkPathInAgentScope(filePath, workDir, sessionWorkDir);
    if (!denyReason) return {};

    logger?.warn('Tool path-scope deny', {
      tool: pre.tool_name,
      filePath,
      reason: denyReason,
    });
    return {
      decision: 'block',
      reason: denyReason,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason,
      },
    };
  };
}

export class ClaudeBackend implements AgentBackend {
  readonly backend = 'claude';

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

  /** AbortControllers for queries currently streaming through {@link streamQuery}. */
  private inflightAborts: Set<AbortController> = new Set();

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
   * Tears down everything the agent owns: cleanup timer, in-flight queries,
   * any orphaned Claude SDK subprocesses, and MCP proxies.
   *
   * Shutdown order matters: we abort first so the SDK can exit cooperatively,
   * wait briefly, then force-kill any subprocess still around (e.g. one wedged
   * waiting for an MCP tool response that never arrives — see
   * https://github.com/anthropics/slackhive/issues for context). Only then do
   * we tear down the MCP proxies, since killing the consumer first lets the
   * proxy http server actually close instead of hanging on dangling SSE.
   */
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

    await sleep(COOPERATIVE_SHUTDOWN_GRACE_MS);

    // The SDK owns spawning the `claude` subprocess and doesn't expose its
    // PID, so we identify orphans after the fact via AGENT_SLUG (set on the
    // runner process, inherited by the SDK subprocess).
    const orphans = findProcessesByEnv('AGENT_SLUG', this.agent.slug);
    if (orphans.length > 0) {
      this.log.warn('Force-killing orphaned Claude subprocesses', {
        count: orphans.length,
        pids: orphans,
      });
      await killProcessesGracefully(orphans, FORCE_KILL_GRACE_MS, this.log);
    }

    await this.mcpManager.stopAll().catch((err) =>
      this.log.warn('Error stopping MCP proxies', { error: (err as Error).message })
    );
  }

  /**
   * Refreshes the OAuth access token using the refresh token from
   * ~/.claude/.credentials.json and writes the new token back.
   * Returns true if the refresh succeeded.
   */
  static async refreshOAuthToken(): Promise<boolean> {
    const credPath = path.join(process.env.HOME || '/root', '.claude', '.credentials.json');
    try {
      const raw = fs.readFileSync(credPath, 'utf-8');
      const creds = JSON.parse(raw);
      const refreshToken = creds?.claudeAiOauth?.refreshToken;
      if (!refreshToken) return false;

      const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
      const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
      const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPES,
      });

      const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!resp.ok) return false;

      const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!data.access_token) return false;

      // Update credentials file so the SDK picks up the new token. Crucially
      // also refresh `expiresAt` from `expires_in` — otherwise the access token
      // is renewed but the status check keeps reading the old (expired) time
      // and reports "expired" even though auth works.
      creds.claudeAiOauth.accessToken = data.access_token;
      if (data.refresh_token) creds.claudeAiOauth.refreshToken = data.refresh_token;
      creds.claudeAiOauth.expiresAt = Date.now() + (data.expires_in ? data.expires_in * 1000 : 8 * 60 * 60 * 1000);
      fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });

      return true;
    } catch {
      return false;
    }
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

      // Copy the compiled instruction doc into the session dir. The agent SDK is
      // confirmed to read CLAUDE.md; we also write AGENTS.md (neutral name, same
      // content) so the on-disk artifact is provider-neutral. Source is AGENTS.md
      // (the canonical name compile-claude-md now emits), falling back to CLAUDE.md.
      const agentDoc = path.join(this.workDir, 'AGENTS.md');
      const legacyDoc = path.join(this.workDir, 'CLAUDE.md');
      const docSrc = fs.existsSync(agentDoc) ? agentDoc : (fs.existsSync(legacyDoc) ? legacyDoc : null);
      if (docSrc) {
        const docContent = fs.readFileSync(docSrc, 'utf8');
        fs.writeFileSync(path.join(sessionDir, 'CLAUDE.md'), docContent, 'utf8');
        fs.writeFileSync(path.join(sessionDir, 'AGENTS.md'), docContent, 'utf8');
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

      // Create memory dir for per-thread memory files (outside .claude/ to avoid SDK sensitive-file blocking)
      fs.mkdirSync(path.join(sessionDir, 'memory'), { recursive: true });

      this.log.debug('Session work dir created', { sessionKey, sessionDir });
    }

    // Ensure the knowledge/ symlink exists. Idempotent — runs every session
    // open so older session dirs (from before the symlink fix) get backfilled.
    // Symlink (not copy) so wiki rebuilds propagate immediately and disk
    // isn't duplicated per thread.
    const agentKnowledge = path.join(this.workDir, 'knowledge');
    const sessionKnowledge = path.join(sessionDir, 'knowledge');
    if (fs.existsSync(agentKnowledge) && !fs.existsSync(sessionKnowledge)) {
      try {
        fs.symlinkSync(agentKnowledge, sessionKnowledge, 'dir');
      } catch (err) {
        this.log.warn('Failed to symlink knowledge dir into session', { error: (err as Error).message });
      }
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
    prompt: AgentPrompt,
    sessionKey: string,
    abortController?: AbortController
  ): AsyncGenerator<BackendMessage, void, unknown> {
    if (abortController) this.inflightAborts.add(abortController);
    try {
      // ClaudeBackend yields raw SDKMessage, which is structurally a superset of
      // BackendMessage (the shape MessageHandler reads); cast at the boundary.
      yield* this.streamQueryInner(prompt, sessionKey, abortController) as unknown as AsyncGenerator<BackendMessage, void, unknown>;
    } finally {
      if (abortController) this.inflightAborts.delete(abortController);
    }
  }

  private async *streamQueryInner(
    prompt: AgentPrompt,
    sessionKey: string,
    abortController?: AbortController
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // Compute current MCP hash to detect config changes
    const currentMcpHash = crypto
      .createHash('sha1')
      .update(JSON.stringify(this.mcpServers.map((s) => ({ name: s.name, config: s.config }))))
      .digest('hex');

    // Resolve existing Claude session ID — invalidate if MCPs changed
    let claudeSessionId = this.sessionCache.get(sessionKey);
    if (!claudeSessionId) {
      const persisted = await getSession(this.agent.id, sessionKey);
      if (persisted?.claudeSessionId) {
        if (persisted.mcpHash && persisted.mcpHash !== currentMcpHash) {
          this.log.info('MCP config changed, starting fresh session', { sessionKey });
        } else {
          claudeSessionId = persisted.claudeSessionId;
          this.sessionCache.set(sessionKey, claudeSessionId);
        }
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
            message: { role: 'user' as const, content: prompt as ContentBlockParam[] },
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
              await upsertSession(this.agent.id, sessionKey, newSessionId, currentMcpHash);
              this.log.debug('Session created', { sessionKey, sessionId: newSessionId, cwd: sessionWorkDir });
            }
          }

          // Intercept auth errors returned as successful results by the SDK
          if (message.type === 'result') {
            const resultText = (message as any).result as string | undefined;
            if (resultText && (resultText.includes('authentication_error') || resultText.includes('Failed to authenticate'))) {
              throw new Error(resultText);
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
        // Retry once on authentication failure — refresh the OAuth token first
        if (!retried && (errMsg.includes('authentication_error') || errMsg.includes('401') || errMsg.includes('Invalid authentication credentials'))) {
          this.log.warn('Authentication failed, attempting OAuth token refresh', { sessionKey });
          const refreshed = await ClaudeBackend.refreshOAuthToken();
          if (refreshed) {
            this.log.info('OAuth token refreshed successfully, retrying query');
            retried = true;
            continue outer;
          }
          this.log.error('OAuth token refresh failed');
          throw new Error('AUTH_EXPIRED: Claude authentication expired. Run `claude login` then `slackhive init` (macOS) to resync credentials.');
        }
        this.log.error('Claude query failed', { sessionKey, error: errMsg });
        throw err;
      }
    }

    await upsertSession(this.agent.id, sessionKey, newSessionId ?? claudeSessionId, currentMcpHash);
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
  private resolveServerConfig(serverName: string, config: McpServerConfig, serverType: McpServerType, sessionWorkDir?: string): McpServerConfig {
    const c = config as McpStdioConfig & Record<string, unknown>;

    if (c.tsSource) {
      const scriptDir = path.join(this.workDir, '.mcp-scripts');
      const scriptPath = path.join(scriptDir, `${serverName}.ts`);
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(scriptPath, c.tsSource as string, 'utf8');
      const resolvedEnv = this.resolveEnvRefs(c);
      // Walk up from __dirname collecting every node_modules found — handles
      // Docker (/app/node_modules), workspace hoisted deps, and per-package
      // installs on any OS without hardcoding parent levels.
      const nmDirs: string[] = [];
      let cur = path.resolve(__dirname);
      while (cur !== path.dirname(cur)) {
        const nm = path.join(cur, 'node_modules');
        if (fs.existsSync(nm)) nmDirs.push(nm);
        cur = path.dirname(cur);
      }
      const tsxPath = nmDirs
        .map(nm => path.join(nm, '.bin', 'tsx'))
        .find(p => fs.existsSync(p)) ?? 'tsx';
      const nodePath = nmDirs.join(path.delimiter);
      return {
        command: tsxPath,
        args: [scriptPath],
        env: {
          ...(process.env as Record<string, string>), // inherit PATH, HOME, git credential helpers
          NODE_PATH: nodePath,
          AGENT_SLUG: this.agent.slug,
          ...(sessionWorkDir ? { SESSION_WORK_DIR: sessionWorkDir } : {}),
          ...resolvedEnv,
        },
      } as McpServerConfig;
    }

    if (c.envRefs && Object.keys(c.envRefs as object).length > 0) {
      const resolvedEnv = this.resolveEnvRefs(c);
      const { envRefs: _, tsSource: __, ...rest } = c;
      const resolved: Record<string, unknown> = { ...rest };

      // Inject type so the SDK can distinguish HTTP/SSE from stdio
      if (serverType === 'http' || serverType === 'sse') resolved.type = serverType;

      // For HTTP/SSE servers, resolve envRefs into headers
      if (resolved.headers && typeof resolved.headers === 'object') {
        const resolvedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(resolved.headers as Record<string, string>)) {
          const envKey = (c.envRefs as Record<string, string>)[key];
          if (envKey && this.envVarValues[envKey]) {
            resolvedHeaders[key] = value ? `${value}${this.envVarValues[envKey]}` : this.envVarValues[envKey];
          } else {
            resolvedHeaders[key] = value;
          }
        }
        resolved.headers = resolvedHeaders;
      }

      if (Object.keys(resolvedEnv).length > 0) resolved.env = resolvedEnv;
      return resolved as unknown as McpServerConfig;
    }

    // Passthrough — inject type for HTTP/SSE so SDK recognises the transport
    if (serverType === 'http' || serverType === 'sse') {
      return { ...config, type: serverType } as unknown as McpServerConfig;
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
      // Whitelist the agent's compile-time workDir so Read/Write of CLAUDE.md,
      // knowledge/wiki/, knowledge/sources/, and .claude/commands/ never trip
      // the path-scope hook below. cwd (sessionWorkDir) is implicitly allowed.
      additionalDirectories: [this.workDir],
      // PreToolUse hook is the actual enforcement: blocks Read/Write/Edit on
      // any path outside workDir + sessionWorkDir. Fires regardless of
      // permissionMode (which would otherwise auto-accept under 'acceptEdits').
      hooks: {
        PreToolUse: [
          {
            hooks: [buildPreToolUsePathScopeHook(this.workDir, sessionWorkDir, this.log)],
          },
        ],
      },
    };

    const rawAllowed: string[] = this.permissions?.allowedTools?.length
      ? this.permissions.allowedTools
      : ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
    const denied: string[] = this.permissions?.deniedTools ?? [];
    const mcpToolPrefixes = this.mcpServers.map((s) => `mcp__${s.name}`);

    // Read and Write are always available — cannot be overridden.
    // When a knowledge wiki exists for this agent, Grep is also force-allowed
    // so the agent can actually search the wiki regardless of operator-configured
    // permissions. Otherwise a locked-down agent with a wiki could never consult it.
    const alwaysAllowed = ['Read', 'Write'];
    const hasWiki = fs.existsSync(path.join(this.workDir, 'knowledge', 'wiki'));
    if (hasWiki) alwaysAllowed.push('Grep');

    // Separate Bash(pattern) rules from plain "Bash" / other tool names.
    // e.g. "Bash(git *)" is a permission rule, plain "Bash" is the tool name.
    const bashRules = rawAllowed.filter((t) => t.startsWith('Bash('));
    const hasPlainBash = rawAllowed.includes('Bash');
    const plainTools = rawAllowed.filter((t) => !t.startsWith('Bash(') && t !== 'Bash');
    const hasAnyBash = bashRules.length > 0 || hasPlainBash;

    // Plain "Bash" with no patterns used to mean "auto-execute any command" — that
    // gave agents host-wide reach (gh CLI, ~/.aws, ~/.ssh, sqlite3 against
    // SlackHive's own DB). It's now silently auto-scoped to the agent's
    // workdir + sessionWorkDir via the platform baseline below; the warning
    // tells operators to migrate to explicit Bash(pattern) rules.
    if (hasPlainBash) {
      this.log.warn(
        'Plain "Bash" permission found in allowed_tools — auto-scoping to agent workdir. ' +
          'Migrate to explicit Bash(pattern) rules in the agent permissions UI.',
        { agent: this.agent.slug },
      );
    }

    const baseTools = hasAnyBash ? [...plainTools, 'Bash'] : plainTools;

    const availableTools = [...new Set([...alwaysAllowed, ...baseTools, ...mcpToolPrefixes])].filter(
      (tool) => !denied.includes(tool)
    );

    // `tools` controls which tools the model can see/use.
    // `allowedTools` controls auto-execution (no prompting). Both use plain tool names.
    options.tools = availableTools;
    options.allowedTools = availableTools;

    // Bash(pattern) rules go into settings.permissions.allow — this is the only place
    // the SDK supports command-level scoping (not in allowedTools/tools).
    //
    // The platform always applies a deny baseline + allow baseline whenever ANY
    // Bash access is granted (whether plain "Bash" or with operator patterns).
    // Operator patterns are layered on top of the allow baseline; deny baseline
    // wins over both, so an operator can't accidentally re-enable a host-secret
    // read by writing a permissive `Bash(pip install *)` rule.
    if (hasAnyBash) {
      const agentsBaseDir = path.dirname(this.workDir); // e.g. /tmp/agents or ~/.slackhive/agents
      const bashDeny = [
        ...denied,
        ...buildBashDenyBaseline(agentsBaseDir),
      ];
      // Operator patterns: substitute {agent} placeholder with actual slug.
      const operatorAllow = bashRules.map(r => r.replace(/\{agent\}/g, this.agent.slug));
      const baselineAllow = buildBashAllowBaseline(this.workDir, sessionWorkDir);
      const bashAllow = [...new Set([...baselineAllow, ...operatorAllow])];
      options.settings = {
        permissions: {
          allow: bashAllow,
          deny: bashDeny,
        },
      };
    }

    if (this.mcpServers.length > 0) {
      options.mcpServers = Object.fromEntries(
        this.mcpServers.map((server) => [server.name, this.resolveServerConfig(server.name, server.config, server.type, sessionWorkDir)])
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
