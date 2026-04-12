/**
 * @fileoverview Agent runner — manages the lifecycle of all Slack bot instances.
 *
 * The AgentRunner is the top-level orchestrator for the runner service.
 * On startup it loads all active agents from the database, starts a Slack
 * Bolt App for each one, and listens on Redis for reload signals from the
 * web UI.
 *
 * Each agent gets:
 * - Its own Bolt App instance (separate Slack socket connection)
 * - Its own ClaudeHandler (session manager, MCP wiring, tool permissions)
 * - Its own MemoryWatcher (syncs learned memories to the database)
 * - A compiled CLAUDE.md in /tmp/agents/{slug}/ (skills + memories)
 *
 * Hot reload flow:
 * 1. User edits skills/MCPs/permissions in the web UI
 * 2. Web API publishes `{ type: 'reload', agentId }` to Redis channel
 * 3. AgentRunner receives the event, stops the agent, recompiles, restarts
 *
 * @module runner/agent-runner
 */

import type { Agent, PlatformAdapter } from '@slackhive/shared';
import { type AgentEvent, getEventBus, type EventBus } from '@slackhive/shared';
import { SlackAdapter } from './adapters/slack-adapter';
import { MessageHandler } from './message-handler';
import { JobScheduler } from './job-scheduler';
import {
  getAllAgents,
  getAgentById,
  getAgentMcpServers,
  getAgentPermissions,
  getAgentRestrictions,
  getAgentMemories,
  getAgentSkills,
  getAllEnvVarValues,
  updateAgentStatus,
  setOptimizeResult,
  setResult,
  getPendingOptimizeRequests,
} from './db';
import { compileClaudeMd, materializeMemoryFiles } from './compile-claude-md';
import { ClaudeHandler } from './claude-handler';
import { MemoryWatcher } from './memory-watcher';
import { logger } from './logger';

/**
 * Represents a fully initialized running agent.
 * All resources owned by a running agent are held here for cleanup.
 */
interface RunningAgent {
  agent: Agent;
  adapter: PlatformAdapter;
  claudeHandler: ClaudeHandler;
  memoryWatcher: MemoryWatcher;
}

/**
 * Manages the lifecycle of all Claude Code Slack bot instances.
 *
 * @example
 * const runner = new AgentRunner();
 * await runner.start();
 * // Ctrl+C triggers graceful shutdown
 */
export class AgentRunner {
  /** Map of agent ID → running agent resources. */
  private runningAgents: Map<string, RunningAgent> = new Map();

  /** Scheduled job executor. */
  private jobScheduler: JobScheduler;

  /** Event bus for hot-reload events (Redis or in-memory). */
  private eventBus: EventBus | null = null;

  /** Timer for polling pending optimize requests from DB. */
  private optimizePollerTimer: NodeJS.Timeout | null = null;

  /** Internal HTTP server for receiving events from the web process. */
  private internalServer: import('http').Server | null = null;

  constructor() {
    this.jobScheduler = new JobScheduler((agentId: string) => this.getRunningAgent(agentId));
  }

  /**
   * Returns any running agent by ID, or undefined if not running.
   */
  getRunningAgent(agentId: string): { adapter: PlatformAdapter; claudeHandler: import('./claude-handler').ClaudeHandler } | undefined {
    const ra = this.runningAgents.get(agentId);
    return ra ? { adapter: ra.adapter, claudeHandler: ra.claudeHandler } : undefined;
  }

  /**
   * Starts the runner:
   * 1. Connects to Redis for hot-reload events
   * 2. Loads and starts all active agents from the database
   * 3. Registers graceful shutdown handlers
   *
   * @returns {Promise<void>}
   * @throws {Error} If Redis connection fails.
   */
  async start(): Promise<void> {
    logger.info('AgentRunner starting...');

    await this.connectEventBus();
    await this.startInternalServer();
    await this.loadAllAgents();
    await this.jobScheduler.start();
    this.startOptimizePoller();
    this.registerShutdownHandlers();

    logger.info('AgentRunner started', { agents: this.runningAgents.size });
  }

  /**
   * Gracefully stops all running agents and disconnects from Redis.
   *
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    logger.info('AgentRunner stopping...');

    // Stop internal server
    if (this.internalServer) { this.internalServer.close(); this.internalServer = null; }
    // Stop optimize poller
    if (this.optimizePollerTimer) { clearInterval(this.optimizePollerTimer); this.optimizePollerTimer = null; }

    // Stop job scheduler
    await this.jobScheduler.stop();

    // Stop all agents concurrently
    const stopPromises = Array.from(this.runningAgents.keys()).map((id) =>
      this.stopAgent(id).catch((err) =>
        logger.warn('Error stopping agent during shutdown', { agentId: id, error: err.message })
      )
    );
    await Promise.all(stopPromises);

    if (this.eventBus) {
      await this.eventBus.close();
      this.eventBus = null;
    }

    logger.info('AgentRunner stopped');
  }

  // ===========================================================================
  // Agent lifecycle
  // ===========================================================================

  /**
   * Loads all agents from the database and starts each one.
   *
   * @returns {Promise<void>}
   */
  private async loadAllAgents(): Promise<void> {
    const agents = await getAllAgents();
    logger.info('Loading agents from database', { count: agents.length });

    // Start agents sequentially to avoid overwhelming Slack's rate limits.
    // Skip agents that are stopped or have placeholder/missing tokens.
    for (const agent of agents) {
      if (agent.enabled === false) {
        logger.info('Skipping disabled agent', { agent: agent.slug });
        continue;
      }
      // Token validation happens in startAgent after loading platform integration
      try {
        await this.startAgent(agent);
      } catch (err) {
        logger.error('Failed to start agent', { agent: agent.slug, error: (err as Error).message });
        await updateAgentStatus(agent.id, 'error');
      }
    }
  }

  /**
   * Starts a single agent:
   * 1. Loads its MCP servers and permissions from the database
   * 2. Compiles CLAUDE.md from skills + memories
   * 3. Materializes memory files to disk
   * 4. Creates Bolt App + ClaudeHandler + MemoryWatcher
   * 5. Registers Slack event handlers
   * 6. Starts the Bolt App (opens Socket Mode connection)
   *
   * @param {Agent} agent - The agent to start.
   * @returns {Promise<void>}
   * @throws {Error} If Slack App fails to start.
   */
  private async startAgent(agent: Agent): Promise<void> {
    if (this.runningAgents.has(agent.id)) {
      logger.warn('Agent already running, skipping start', { agent: agent.slug });
      return;
    }

    logger.info('Starting agent', { agent: agent.slug });

    // Load configuration from DB
    const [mcpServers, permissions, restrictions, memories, envVarValues] = await Promise.all([
      getAgentMcpServers(agent.id),
      getAgentPermissions(agent.id),
      getAgentRestrictions(agent.id),
      getAgentMemories(agent.id),
      getAllEnvVarValues(),
    ]);

    // Compile CLAUDE.md (identity + skills → temp workspace)
    const workDir = await compileClaudeMd(agent);

    // Materialize memory files so the /recall skill can read them
    materializeMemoryFiles(agent, memories);

    // Create Claude Code SDK handler
    const claudeHandler = new ClaudeHandler(agent, mcpServers, permissions, workDir, envVarValues);
    claudeHandler.initialize();

    // Create memory watcher (persists SDK memory writes back to DB)
    const memoryWatcher = new MemoryWatcher(agent);
    memoryWatcher.start();

    // Load platform integration from DB
    const { getPlatformIntegration, updateAgentSlackUserId } = await import('./db');
    const integration = await getPlatformIntegration(agent.id, 'slack');
    if (!integration) {
      logger.warn('No platform integration found, skipping agent', { agent: agent.slug });
      memoryWatcher.stop();
      claudeHandler.destroy();
      return;
    }

    // Create platform adapter
    const adapter = new SlackAdapter(
      { platform: 'slack', botToken: integration.credentials.botToken, appToken: integration.credentials.appToken, signingSecret: integration.credentials.signingSecret },
      agent.slug,
    );

    // Wire message handler: adapter → MessageHandler → ClaudeHandler
    const messageHandler = new MessageHandler(adapter, claudeHandler, agent, restrictions);
    adapter.onMessage(msg => messageHandler.handleMessage(msg));

    // Start the platform connection
    await adapter.start();

    // Store bot user ID discovered during start
    const botUserId = adapter.getBotUserId();
    if (botUserId && botUserId !== integration.botUserId) {
      await updateAgentSlackUserId(agent.id, botUserId);
      agent.slackBotUserId = botUserId;
    }

    this.runningAgents.set(agent.id, { agent, adapter, claudeHandler, memoryWatcher });
    await updateAgentStatus(agent.id, 'running');

    logger.info('Agent started', {
      agent: agent.slug,
      mcpServers: mcpServers.map((m) => m.name),
    });
  }

  /**
   * Stops a running agent and cleans up all its resources.
   *
   * @param {string} agentId - UUID of the agent to stop.
   * @returns {Promise<void>}
   */
  private async stopAgent(agentId: string): Promise<void> {
    const running = this.runningAgents.get(agentId);
    if (!running) return;

    const { agent, adapter, claudeHandler, memoryWatcher } = running;
    logger.info('Stopping agent', { agent: agent.slug });

    memoryWatcher.stop();
    claudeHandler.destroy();

    try {
      await adapter.stop();
    } catch (err) {
      logger.warn('Error stopping platform adapter', { agent: agent.slug, error: err });
    }

    this.runningAgents.delete(agentId);
    await updateAgentStatus(agentId, 'stopped');

    logger.info('Agent stopped', { agent: agent.slug });
  }

  /**
   * Reloads an agent: stops it, re-fetches its config, recompiles, and restarts.
   * Called when the web UI publishes a reload event.
   *
   * @param {string} agentId - UUID of the agent to reload.
   * @returns {Promise<void>}
   */
  private async reloadAgent(agentId: string): Promise<void> {
    logger.info('Reloading agent', { agentId });

    await this.stopAgent(agentId);

    const agent = await getAgentById(agentId);
    if (!agent) {
      logger.warn('Agent not found after reload event', { agentId });
      return;
    }

    await this.startAgent(agent);
  }

  // ===========================================================================
  // Event bus (Redis or in-memory)
  // ===========================================================================

  /**
   * Connects to the event bus and subscribes to agent lifecycle events.
   * Uses Redis if REDIS_URL is set, otherwise falls back to in-memory EventEmitter.
   *
   * @returns {Promise<void>}
   */
  private async connectEventBus(): Promise<void> {
    this.eventBus = getEventBus();

    await this.eventBus.subscribe((event: AgentEvent) => {
      logger.info('Received agent event', { event });

      switch (event.type) {
        case 'reload':
          this.reloadAgent(event.agentId).catch((err) =>
            logger.error('Failed to reload agent', { agentId: event.agentId, error: err.message })
          );
          break;
        case 'start':
          getAgentById(event.agentId)
            .then((agent) => agent && this.startAgent(agent))
            .catch((err) =>
              logger.error('Failed to start agent', { agentId: event.agentId, error: err.message })
            );
          break;
        case 'stop':
          this.stopAgent(event.agentId).catch((err) =>
            logger.error('Failed to stop agent', { agentId: event.agentId, error: err.message })
          );
          break;
        case 'reload-jobs':
          this.jobScheduler.reload().catch((err) =>
            logger.error('Failed to reload jobs', { error: (err as Error).message })
          );
          break;
        case 'optimize':
          this.optimizeAgent(event.agentId, event.requestId).catch((err) =>
            logger.error('Failed to optimize agent', { agentId: event.agentId, error: err.message })
          );
          break;
      }
    });

    logger.info('Event bus connected', { type: this.eventBus.type });
  }

  // ===========================================================================
  // Internal HTTP server — receives events from the web process
  // ===========================================================================

  /**
   * Starts a lightweight HTTP server on RUNNER_INTERNAL_PORT (default 3002).
   * The web process POSTs agent lifecycle events here instead of using
   * the in-memory event bus (which doesn't cross process boundaries).
   */
  private async startInternalServer(): Promise<void> {
    const http = await import('http');
    const port = parseInt(process.env.RUNNER_INTERNAL_PORT ?? '3002', 10);

    this.internalServer = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const event = JSON.parse(body) as AgentEvent;
          logger.info('Internal event received', { event });

          switch (event.type) {
            case 'reload':
              await this.reloadAgent(event.agentId);
              break;
            case 'start':
              const agent = await getAgentById(event.agentId);
              if (agent) await this.startAgent(agent);
              break;
            case 'stop':
              await this.stopAgent(event.agentId);
              break;
            case 'reload-jobs':
              await this.jobScheduler.reload();
              break;
            case 'optimize':
              this.optimizeAgent(event.agentId, event.requestId).catch(err =>
                logger.error('Optimize failed', { error: err.message })
              );
              break;
            default: {
              // Handle mcp-auth, analyze-memories, and other custom events
              const raw = event as any;
              if (raw.type === 'mcp-auth') {
                this.authenticateMcp(raw.requestId, raw.mcpUrl, raw.mcpName).catch(err =>
                  logger.error('MCP auth failed', { error: err.message })
                );
              }
              if (raw.type === 'analyze-memories') {
                this.analyzeMemories(raw.agentId, raw.requestId).catch(err =>
                  logger.error('Memory analysis failed', { error: err.message })
                );
              }
              if (raw.type === 'build-knowledge') {
                this.buildKnowledgeWiki(raw.agentId, raw.requestId).catch(err =>
                  logger.error('Knowledge build failed', { error: err.message })
                );
              }
              if (raw.type === 'ingest-source') {
                this.ingestSingleSource(raw.agentId, raw.sourceId, raw.requestId).catch(err =>
                  logger.error('Source ingest failed', { error: err.message })
                );
              }
              break;
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          logger.error('Internal event error', { error: (err as Error).message });
          res.writeHead(500);
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
    });

    this.internalServer.listen(port, '127.0.0.1', () => {
      logger.info('Internal event server started', { port });
    });
  }

  // ===========================================================================
  // Optimize poller — checks DB for pending requests (cross-process safe)
  // ===========================================================================

  private startOptimizePoller(): void {
    this.optimizePollerTimer = setInterval(async () => {
      try {
        const pending = await getPendingOptimizeRequests();
        for (const { requestId, agentId } of pending) {
          logger.info('Found pending optimize request', { requestId, agentId });
          this.optimizeAgent(agentId, requestId).catch(err =>
            logger.error('Optimize failed', { requestId, error: err.message })
          );
        }
      } catch { /* ignore poll errors */ }
    }, 3000);
  }

  // ===========================================================================
  // Optimize agent instructions via Claude
  // ===========================================================================

  /**
   * Calls Claude to analyze and suggest improvements for an agent's instructions.
   * Result is stored in the DB for the web UI to poll.
   */
  private async optimizeAgent(agentId: string, requestId: string): Promise<void> {
    logger.info('Optimizing agent instructions', { agentId, requestId });

    try {
      const agent = await getAgentById(agentId);
      if (!agent) {
        await setOptimizeResult(requestId, JSON.stringify({ status: 'error', error: 'Agent not found' }));
        return;
      }

      const [skills, memories, mcpServers] = await Promise.all([
        getAgentSkills(agentId),
        getAgentMemories(agentId),
        getAgentMcpServers(agentId),
      ]);

      // Build context
      const skillsList = skills.map(s =>
        `### ${s.category}/${s.filename}\n\`\`\`\n${s.content}\n\`\`\``
      ).join('\n\n');

      const mcpList = mcpServers.length > 0
        ? mcpServers.map(m => `- **${m.name}** (${m.type}) — ${m.description || 'no description'}`).join('\n')
        : '(none connected)';

      const optimizationPrompt = `You are an expert at optimizing Claude Code agent configurations for Slack-based AI teams.

CRITICAL: Your entire response must be a single JSON object. No text before or after. No markdown fences. Start with { end with }.

## How SlackHive agents work

An agent has two types of instructions:

1. **System Prompt** (CLAUDE.md) — Always in context for every conversation. Put here:
   - Core identity and role definition
   - Response rules and formatting guidelines
   - Workflow steps the agent should always follow
   - References to connected MCP tools and how to use them
   - Channel-specific behavior rules

2. **Skills** — Separate /command files the agent invokes on demand. Put here:
   - Domain-specific knowledge (schema docs, API references)
   - Specialized workflows for specific tasks
   - Reference material the agent looks up when relevant
   - NOT basic identity — that goes in the system prompt

Additionally, the agent automatically gets:
- A /recall command that reads from persistent memory files
- Slack formatting instructions (built-in, not visible)
- Memory save instructions (built-in, not visible)

## Agent being optimized
Name: ${agent.name}
Description: ${agent.description || '(none set)'}
Persona: ${agent.persona || '(none set)'}
Model: ${agent.model}

## Connected MCP Tools
${mcpList}
${mcpServers.length > 0 ? '\nThe system prompt should reference these tools and explain when/how to use them.' : ''}

## Current System Prompt
${agent.claudeMd || '(empty — the agent has no custom system prompt yet)'}

## Current Skills (${skills.length} files)
${skillsList || '(no skills created yet)'}

## Learned Memories (${memories.length})
${memories.length > 0 ? memories.map(m => `- **${m.type}**: ${m.name} — ${m.content.slice(0, 150)}`).join('\n') : '(no memories yet)'}

## Return this JSON structure:
{
  "score": <0-100>,
  "summary": "<2-3 sentence assessment of current state>",
  "systemPrompt": {
    "issues": ["<specific problem>"],
    "suggestion": "<complete improved system prompt text>",
    "explanation": "<why this is better>"
  },
  "skills": [
    {
      "filename": "<name>.md",
      "category": "00-core",
      "action": "improve" | "create" | "delete",
      "suggestion": "<full content>",
      "explanation": "<why>"
    }
  ],
  "memoryActions": [
    {
      "memoryId": "<id or name>",
      "action": "move_to_skill" | "update_prompt" | "merge" | "delete" | "keep",
      "reason": "<brief explanation>"
    }
  ],
  "tips": ["<actionable tip>"]
}

Guidelines:
- If system prompt is empty, write a complete one based on persona/description/MCPs
- If MCPs are connected, the system prompt MUST mention them and explain usage patterns
- Move domain knowledge from system prompt to skills (keep system prompt focused on behavior)
- Skills should be self-contained reference docs, not behavior rules
- Score: 0-30 needs major work, 30-60 decent, 60-80 good, 80+ excellent
- Keep suggestions practical for a Slack bot (concise replies, Slack markdown)
- NEVER suggest changes to identity.md — it is auto-generated and read-only
- Use the identity (persona/description) as context to improve OTHER skills and the system prompt`;

      // Mark as running
      await setOptimizeResult(requestId, JSON.stringify({ status: 'running' }));

      // Call Claude SDK with auth retry chain
      const fullResponse = await this.callClaudeWithRetry(optimizationPrompt);

      // Parse JSON from response — try multiple extraction strategies
      let parsed: any = null;
      const strategies = [
        () => JSON.parse(fullResponse),                                           // Raw JSON
        () => { const m = fullResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/); return m ? JSON.parse(m[1]) : null; },  // Fenced
        () => { const s = fullResponse.indexOf('{'); const e = fullResponse.lastIndexOf('}'); return s >= 0 && e > s ? JSON.parse(fullResponse.slice(s, e + 1)) : null; },  // Extract braces
      ];
      for (const strategy of strategies) {
        try { parsed = strategy(); if (parsed) break; } catch { /* try next */ }
      }
      if (!parsed) throw new Error('JSON_PARSE: Could not extract JSON from Claude response');

      await setOptimizeResult(requestId, JSON.stringify({ status: 'done', ...parsed }));
      logger.info('Optimization complete', { agentId, requestId, score: parsed.score });

    } catch (err) {
      const message = (err as Error).message ?? String(err);
      logger.error('Optimization failed', { agentId, requestId, error: message });

      let userError = 'Optimization failed. ';
      if (message.includes('AUTH_NEEDS_LOGIN')) {
        userError = 'Run `claude login` in your terminal, then restart SlackHive.';
      } else if (message.includes('401') || message.includes('auth') || message.includes('credentials')) {
        userError += 'Claude not authenticated. Run `claude login` in your terminal.';
      } else if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
        userError += 'Request timed out. Try again.';
      } else if (message.includes('rate') || message.includes('429')) {
        userError += 'Rate limited. Wait a moment and try again.';
      } else if (message.includes('JSON')) {
        userError += 'Claude returned an unexpected format. Try again.';
      } else {
        userError += message;
      }

      await setOptimizeResult(requestId, JSON.stringify({ status: 'error', error: userError }));
    }
  }

  // ===========================================================================
  // Graceful shutdown
  // ===========================================================================

  /**
   * Registers SIGTERM and SIGINT handlers for graceful shutdown.
   * Ensures all agents are cleanly stopped before the process exits.
   *
   * @returns {void}
   */
  private registerShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // ===========================================================================
  // Claude SDK call with auth retry chain
  // ===========================================================================

  /**
   * Calls Claude SDK with auth retry:
   * 1. Try SDK call
   * 2. On auth error → sync from Keychain (macOS) → retry
   * 3. On auth error → refresh token via OAuth endpoint → retry
   * 4. On auth error → throw AUTH_NEEDS_LOGIN
   */
  /**
   * Analyzes an agent's memories and suggests actions: move_to_skill, update_prompt, merge, delete.
   * Result is stored in the DB for the web UI to poll.
   */
  /**
   * Builds the knowledge wiki from all sources for an agent.
   * For git repos: clones to temp dir, reads files, deletes clone.
   * For URLs/files: reads content from DB.
   * Calls Claude to compile structured wiki articles.
   */
  // ─── Knowledge Wiki (Karpathy Incremental Ingest) ────────────────────────

  /**
   * Reads a git repo into a content string for wiki compilation.
   * Clones to temp dir, reads deeply, deletes clone.
   */
  private async readRepoContent(src: Record<string, unknown>): Promise<string> {
    const fs = await import('fs');
    const path = await import('path');
    const { execSync } = await import('child_process');
    const tmpDir = path.join('/tmp', `slackhive-repo-${src.id}`);

    // Helper: safe read file
    const read = (p: string, max = 0) => {
      try { const c = fs.readFileSync(p, 'utf-8'); return max ? c.slice(0, max) : c; } catch { return ''; }
    };
    // Helper: find files matching pattern, excluding noise
    const findFiles = (pattern: string, maxDepth = 6, limit = 500): string[] => {
      try {
        return execSync(
          `find "${tmpDir}" -maxdepth ${maxDepth} -type f ${pattern} ` +
          `-not -path "*/node_modules/*" -not -path "*/.git/*" ` +
          `-not -path "*/dist/*" -not -path "*/.next/*" -not -path "*/.nuxt/*" ` +
          `-not -path "*/__pycache__/*" -not -path "*/venv/*" -not -path "*/.venv/*" ` +
          `-not -path "*/target/*" -not -path "*/.cache/*" -not -path "*/build/*" ` +
          `-not -path "*/vendor/*" -not -path "*/.tox/*" ` +
          `| head -${limit}`,
          { encoding: 'utf-8', timeout: 10000 }
        ).trim().split('\n').filter(Boolean);
      } catch { return []; }
    };
    const rel = (p: string) => p.replace(tmpDir + '/', '');
    const section = (title: string, content: string) => content.trim() ? `\n## ${title}\n${content}` : '';
    const fileBlock = (relPath: string, content: string) => `\n### ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`;

    try {
      let cloneUrl = src.repo_url as string;
      if (src.pat_env_ref) {
        const envVars = await getAllEnvVarValues();
        const pat = envVars[src.pat_env_ref as string];
        if (pat && cloneUrl.startsWith('https://')) cloneUrl = cloneUrl.replace('https://', `https://${pat}@`);
      }

      const branch = (src.branch as string) || 'main';
      execSync(`git clone --depth 1 --branch ${branch} "${cloneUrl}" "${tmpDir}"`, { stdio: 'ignore', timeout: 120000 });

      const sections: string[] = [];
      sections.push(`# Repository: ${src.name}\nBranch: ${branch} | URL: ${src.repo_url}`);

      // ─── 1. Documentation ──────────────────────────────────────────
      let readme = '';
      for (const f of ['README.md', 'readme.md', 'README.rst', 'README', 'docs/README.md']) {
        const c = read(path.join(tmpDir, f));
        if (c) { readme = c; break; }
      }
      sections.push(section('README', readme));

      let docs = '';
      for (const f of ['CONTRIBUTING.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md', 'docs/api.md', 'API.md', 'CLAUDE.md', 'AGENTS.md', 'docs/design.md', 'DESIGN.md']) {
        const c = read(path.join(tmpDir, f), 8000);
        if (c) docs += fileBlock(f, c);
      }
      sections.push(section('Documentation', docs));

      // ─── 2. Directory tree (full picture first) ────────────────────
      let tree = '';
      try {
        tree = execSync(
          `find "${tmpDir}" -maxdepth 5 -type f ` +
          `-not -path "*/node_modules/*" -not -path "*/.git/*" ` +
          `-not -path "*/dist/*" -not -path "*/.next/*" ` +
          `-not -path "*/__pycache__/*" -not -path "*/venv/*" ` +
          `-not -path "*/target/*" -not -path "*/.cache/*" -not -path "*/vendor/*" ` +
          `| sort | head -400`,
          { encoding: 'utf-8', timeout: 10000 }
        ).replace(new RegExp(tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.');
      } catch { /* ok */ }
      sections.push(section('Directory Structure', '```\n' + tree + '\n```'));

      // ─── 3. Code structure map (classes, functions, exports) ───────
      // Extract structural outline from ALL source files — gives Claude
      // a complete map even for files not read fully later.
      const allSrcForMap = findFiles(
        '\\( -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.go" ' +
        '-o -name "*.rs" -o -name "*.java" -o -name "*.js" -o -name "*.jsx" ' +
        '-o -name "*.rb" -o -name "*.kt" -o -name "*.swift" \\)',
        6, 500
      ).filter(f => !f.includes('node_modules') && !f.includes('.test.') && !f.includes('.spec.') && !f.includes('__tests__'));

      let codeMap = '';
      for (const f of allSrcForMap) {
        const content = read(f);
        if (!content) continue;
        const relPath = rel(f);
        const lines: string[] = [];

        // Extract imports (first 30 lines typically)
        const imports = content.split('\n').filter(l =>
          /^\s*(import |from |require\(|use |using |#include)/.test(l)
        ).slice(0, 15);
        if (imports.length) lines.push('  imports: ' + imports.map(i => i.trim()).join('; ').slice(0, 300));

        // Extract class/struct/interface definitions
        const classMatches = content.matchAll(
          /^(?:export\s+)?(?:abstract\s+)?(?:class|struct|interface|enum|type|trait|protocol)\s+(\w+)(?:\s*(?:extends|implements|<|:|\().*)?/gm
        );
        for (const m of classMatches) lines.push('  class: ' + m[0].trim().slice(0, 200));

        // Python classes
        const pyClasses = content.matchAll(/^class\s+(\w+)(?:\(.*?\))?:/gm);
        for (const m of pyClasses) lines.push('  class: ' + m[0].trim());

        // Function/method signatures (exported or top-level)
        const fnMatches = content.matchAll(
          /^(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+)(\w+)\s*(?:=\s*(?:async\s*)?\(|[(<])/gm
        );
        for (const m of fnMatches) lines.push('  fn: ' + m[0].trim().slice(0, 150));

        // Python functions
        const pyFns = content.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(.*?\)(?:\s*->.*?)?:/gm);
        for (const m of pyFns) lines.push('  fn: ' + m[0].trim().slice(0, 150));

        // Go functions
        const goFns = content.matchAll(/^func\s+(?:\(.*?\)\s+)?(\w+)\s*\(.*?\)(?:\s*(?:\(.*?\)|[\w.]+))?\s*\{/gm);
        for (const m of goFns) lines.push('  fn: ' + m[0].replace('{', '').trim().slice(0, 150));

        // Rust functions
        const rsFns = content.matchAll(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)(?:<.*?>)?\s*\(.*?\)(?:\s*->.*?)?\s*\{/gm);
        for (const m of rsFns) lines.push('  fn: ' + m[0].replace('{', '').trim().slice(0, 150));

        // Java methods (inside classes)
        const javaMethods = content.matchAll(/^\s+(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/gm);
        for (const m of javaMethods) lines.push('  method: ' + m[0].trim().slice(0, 150));

        // Exports
        const exports = content.matchAll(/^(?:export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)|module\.exports\s*=)/gm);
        const exportNames: string[] = [];
        for (const m of exports) if (m[1]) exportNames.push(m[1]);
        if (exportNames.length) lines.push('  exports: ' + exportNames.join(', '));

        if (lines.length > 0) {
          codeMap += `${relPath}\n${lines.join('\n')}\n`;
        }
      }
      sections.push(section('Code Structure Map', '```\n' + codeMap + '\n```'));

      // ─── 4. Dependencies & libraries ───────────────────────────────
      let deps = '';
      // JS/TS ecosystem
      for (const f of ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
        const c = read(path.join(tmpDir, f), f === 'package.json' ? 8000 : 0);
        if (c && f === 'package.json') deps += fileBlock(f, c);
      }
      // Python ecosystem
      for (const f of ['requirements.txt', 'Pipfile', 'pyproject.toml', 'setup.py', 'setup.cfg', 'poetry.lock']) {
        const c = read(path.join(tmpDir, f), 6000);
        if (c) deps += fileBlock(f, c);
      }
      // Other ecosystems
      for (const f of ['Cargo.toml', 'go.mod', 'go.sum', 'Gemfile', 'build.gradle', 'pom.xml', 'mix.exs', 'composer.json']) {
        const c = read(path.join(tmpDir, f), 4000);
        if (c) deps += fileBlock(f, c);
      }
      // Monorepo: sub-package manifests
      for (const f of findFiles('-name "package.json" -o -name "pyproject.toml" -o -name "Cargo.toml"', 3, 20)) {
        if (f === path.join(tmpDir, 'package.json')) continue;
        deps += fileBlock(rel(f), read(f, 3000));
      }
      sections.push(section('Dependencies & Libraries', deps));

      // ─── 4. Database schemas & migrations ──────────────────────────
      let dbSection = '';
      // SQL migrations
      const sqlFiles = findFiles('\\( -name "*.sql" \\)', 6, 30);
      for (const f of sqlFiles.slice(0, 15)) {
        dbSection += fileBlock(rel(f), read(f, 6000));
      }
      // ORM schema files (Prisma, SQLAlchemy, Django, TypeORM, Drizzle, Sequelize)
      const schemaFiles = findFiles(
        '\\( -name "schema.prisma" -o -name "schema.ts" -o -name "schema.py" ' +
        '-o -name "models.py" -o -name "models.ts" -o -name "*.entity.ts" ' +
        '-o -name "drizzle.config.*" -o -name "migration.*" ' +
        '-o -name "*.model.ts" -o -name "*.model.py" -o -name "*.model.js" \\)',
        6, 30
      );
      for (const f of schemaFiles) {
        dbSection += fileBlock(rel(f), read(f, 6000));
      }
      sections.push(section('Database Schemas & Migrations', dbSection));

      // ─── 5. API definitions ────────────────────────────────────────
      let apiSection = '';
      // OpenAPI / Swagger
      const apiFiles = findFiles(
        '\\( -name "openapi.*" -o -name "swagger.*" -o -name "*.graphql" ' +
        '-o -name "*.gql" -o -name "*.proto" -o -name "schema.graphql" ' +
        '-o -name "*.openapi.yaml" -o -name "*.openapi.json" \\)',
        6, 20
      );
      for (const f of apiFiles) {
        apiSection += fileBlock(rel(f), read(f, 8000));
      }
      sections.push(section('API Definitions', apiSection));

      // ─── 6. Configuration & environment ────────────────────────────
      let configSection = '';
      for (const f of [
        'tsconfig.json', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
        '.env.example', '.env.sample', 'config.yaml', 'config.yml', 'config.json',
        'settings.py', 'config.py', 'application.yml', 'application.properties',
        '.github/workflows/ci.yml', '.github/workflows/deploy.yml',
        'nx.json', 'turbo.json', 'lerna.json', 'pnpm-workspace.yaml',
        'next.config.js', 'next.config.ts', 'vite.config.ts', 'webpack.config.js',
        'jest.config.js', 'jest.config.ts', 'vitest.config.ts',
      ]) {
        const c = read(path.join(tmpDir, f), 4000);
        if (c) configSection += fileBlock(f, c);
      }
      sections.push(section('Configuration & Environment', configSection));

      // ─── 7. Entry points & main files ──────────────────────────────
      let entrySection = '';
      const entryPatterns = [
        'index.ts', 'index.js', 'main.ts', 'main.py', 'main.go', 'main.rs',
        'app.ts', 'app.py', 'app.js', 'server.ts', 'server.py', 'server.js',
        'cli.ts', 'cli.py', '__main__.py', 'manage.py', 'wsgi.py', 'asgi.py',
        'cmd/main.go', 'src/main.rs', 'src/lib.rs',
      ];
      for (const f of entryPatterns) {
        const c = read(path.join(tmpDir, f), 8000);
        if (c) entrySection += fileBlock(f, c);
      }
      // Also find entry points in src/ directories
      for (const f of findFiles('\\( -name "index.ts" -o -name "index.js" -o -name "main.py" -o -name "__init__.py" -o -name "mod.rs" \\)', 3, 30)) {
        const r = rel(f);
        if (!entryPatterns.includes(r) && !r.includes('node_modules')) {
          entrySection += fileBlock(r, read(f, 5000));
        }
      }
      sections.push(section('Entry Points', entrySection));

      // ─── 8. Types, models & interfaces ─────────────────────────────
      let typesSection = '';
      const typeFiles = findFiles(
        '\\( -name "types.ts" -o -name "types.py" -o -name "interfaces.ts" ' +
        '-o -name "*.types.ts" -o -name "*.interface.ts" -o -name "*.d.ts" ' +
        '-o -name "types.go" -o -name "structs.go" ' +
        '-o -name "schemas.py" -o -name "serializers.py" ' +
        '-o -name "*.dto.ts" -o -name "*.input.ts" \\)',
        6, 40
      );
      // Exclude .d.ts from dependencies
      for (const f of typeFiles.filter(f => !f.includes('node_modules')).slice(0, 20)) {
        typesSection += fileBlock(rel(f), read(f, 6000));
      }
      sections.push(section('Types, Models & Interfaces', typesSection));

      // ─── 9. Routes, handlers & controllers ─────────────────────────
      let routesSection = '';
      const routeFiles = findFiles(
        '\\( -name "*route*" -o -name "*router*" -o -name "*controller*" ' +
        '-o -name "*handler*" -o -name "*endpoint*" -o -name "*view*" ' +
        '-o -name "*resolver*" -o -name "urls.py" -o -name "views.py" \\)',
        6, 40
      );
      for (const f of routeFiles.filter(f => !f.includes('node_modules') && !f.includes('.test.')).slice(0, 20)) {
        routesSection += fileBlock(rel(f), read(f, 5000));
      }
      sections.push(section('Routes, Handlers & Controllers', routesSection));

      // ─── 10. Services, business logic ──────────────────────────────
      let servicesSection = '';
      const serviceFiles = findFiles(
        '\\( -name "*service*" -o -name "*manager*" -o -name "*provider*" ' +
        '-o -name "*repository*" -o -name "*adapter*" -o -name "*client*" ' +
        '-o -name "*worker*" -o -name "*processor*" -o -name "*engine*" ' +
        '-o -name "*pipeline*" -o -name "*task*" \\)',
        6, 60
      );
      for (const f of serviceFiles.filter(f => !f.includes('node_modules') && !f.includes('.test.') && !f.includes('.spec.')).slice(0, 25)) {
        servicesSection += fileBlock(rel(f), read(f, 5000));
      }
      sections.push(section('Services & Business Logic', servicesSection));

      // ─── 11. Remaining source files ────────────────────────────────
      // Files not yet captured by any category above
      const allSrcExts = '\\( -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.js" -o -name "*.jsx" -o -name "*.rb" -o -name "*.kt" -o -name "*.swift" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" \\)';
      const allSrc = findFiles(allSrcExts, 6, 500)
        .filter(f => !f.includes('node_modules') && !f.includes('.test.') && !f.includes('.spec.') && !f.includes('__tests__'));
      // Collect paths already included
      const alreadyIncluded = new Set([
        ...sqlFiles, ...schemaFiles, ...apiFiles, ...typeFiles, ...routeFiles, ...serviceFiles,
      ]);
      const remaining = allSrc.filter(f => !alreadyIncluded.has(f));
      let otherFiles = '';
      for (const f of remaining.slice(0, 40)) {
        otherFiles += fileBlock(rel(f), read(f, 3000));
      }
      sections.push(section(`Other Source Files (${remaining.length} total, showing ${Math.min(40, remaining.length)})`, otherFiles));

      // ─── 12. Test files (sample for patterns) ─────────────────────
      let testSection = '';
      const testFiles = findFiles('\\( -name "*.test.*" -o -name "*.spec.*" -o -name "test_*" -o -name "*_test.go" -o -name "*_test.py" \\)', 6, 20);
      for (const f of testFiles.slice(0, 5)) {
        testSection += fileBlock(rel(f), read(f, 3000));
      }
      sections.push(section('Test Files (sample)', testSection));

      return sections.filter(s => s.trim()).join('\n');

    } finally {
      try { (await import('child_process')).execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' }); } catch { /* ok */ }
    }
  }

  /** Parse JSON from Claude response, trying multiple strategies. */
  private parseWikiJson(response: string): any | null {
    for (const strategy of [
      () => JSON.parse(response),
      () => { const m = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/); return m ? JSON.parse(m[1]) : null; },
      () => { const s = response.indexOf('{'); const e = response.lastIndexOf('}'); return s >= 0 && e > s ? JSON.parse(response.slice(s, e + 1)) : null; },
    ]) {
      try { const p = strategy(); if (p) return p; } catch { /* try next */ }
    }
    return null;
  }

  /** Read existing wiki state: article paths + titles + first lines. */
  private readExistingWiki(wikiDir: string): string {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    if (!fs.existsSync(wikiDir)) return '(empty — no wiki yet)';

    const articles: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.name.endsWith('.md')) {
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
          const titleMatch = content.match(/^#\s+(.+)/m);
          const title = titleMatch ? titleMatch[1] : entry.name.replace('.md', '');
          // First 2 meaningful lines after title
          const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 2).join(' ').slice(0, 200);
          articles.push(`- [${title}](${relPath}) — ${lines}`);
        }
      }
    };
    walk(wikiDir, '');
    return articles.length > 0 ? articles.join('\n') : '(empty — no wiki yet)';
  }

  /**
   * Ingest a single source into the wiki (Karpathy incremental pattern).
   * Reads the source fully, sees existing wiki, updates/creates articles.
   */
  private async ingestSource(
    agentId: string,
    sourceId: string,
    requestId: string,
    mode: 'ingest' | 'sync' = 'ingest',
  ): Promise<{ created: number; updated: number }> {
    const fs = await import('fs');
    const path = await import('path');
    const { getDb } = await import('@slackhive/shared');
    const { getAgentWorkDir } = await import('./compile-claude-md');

    const agent = await getAgentById(agentId);
    if (!agent) throw new Error('Agent not found');

    const r = await getDb().query('SELECT * FROM knowledge_sources WHERE id = $1', [sourceId]);
    const src = r.rows[0];
    if (!src) throw new Error('Source not found');

    const srcName = src.name as string;
    const srcType = src.type as string;
    const wikiDir = path.join(getAgentWorkDir(agent.slug), 'knowledge', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });

    const updateStatus = async (step: string) => {
      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'building', startedAt: Date.now(), step,
      }));
    };

    // 1. Read source content fully
    let content = '';
    if (srcType === 'url' || srcType === 'file') {
      content = (src.content as string) || '';
      if (!content) throw new Error(`Source "${srcName}" has no content`);
    } else if (srcType === 'repo') {
      await updateStatus(`Cloning ${srcName}...`);
      content = await this.readRepoContent(src);
    }

    // 2. Read existing wiki state + manifest
    const existingWiki = this.readExistingWiki(wikiDir);
    const wikiIsEmpty = existingWiki === '(empty — no wiki yet)';

    // Read manifest to check if this source was ever ingested
    const manifestPath = path.join(wikiDir, 'manifest.json');
    let manifest: Record<string, { created: string[]; updated: string[] }> = {};
    try {
      if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch { /* ok */ }
    const sourceEverIngested = !!manifest[srcName];

    // Determine effective mode: new source that was never ingested gets full treatment
    const effectiveMode = wikiIsEmpty ? 'first' : (sourceEverIngested && mode === 'sync') ? 'sync' : 'new-source';

    // 3. Call Claude
    await updateStatus(`${effectiveMode === 'sync' ? 'Syncing' : 'Ingesting'} ${srcName}...`);
    const now = new Date().toISOString().split('T')[0];

    const modeInstruction = effectiveMode === 'first'
      ? `This is the FIRST source being ingested into an empty wiki. Create a comprehensive wiki from scratch — 20-40 articles covering every module, concept, entity, and flow.`
      : effectiveMode === 'new-source'
      ? `This is a NEW source being added to an existing wiki. This is a DIFFERENT codebase from what's already there. Create COMPREHENSIVE articles for EVERYTHING in this source — every module, every concept, every entity, every flow. Aim for 15-30+ new articles. Also update existing articles where this source adds relevant cross-references or shared concepts.`
      : `This source was previously ingested and is being RE-SYNCED. Check what changed and update affected articles. Add new articles for any new code or concepts.`;

    const prompt = `You are maintaining a knowledge wiki following the Karpathy LLM Wiki pattern.

${modeInstruction}

CRITICAL: Return ONLY a JSON object. No text before or after.

## Existing wiki
${existingWiki}

## Source: ${srcName} (${srcType})

${content}

## Your task

1. Read the source thoroughly — understand every module, class, function, pattern
2. ${effectiveMode === 'first'
  ? 'Create the initial wiki: overview.md + module pages + concept pages + entity pages + flow pages. Be exhaustive — 20-40 articles.'
  : effectiveMode === 'new-source'
  ? 'Create COMPREHENSIVE articles for everything in this source. Each module, concept, entity, and flow deserves its own article. Do NOT skip anything because a similar concept exists from another source — this is a different codebase. Also update existing articles where this source adds new information.'
  : 'Check what changed vs existing wiki. Update affected articles. Add new articles for new code/concepts.'}
3. ${effectiveMode === 'first' ? 'Create' : 'Update'} index.md — full catalog of ALL articles
4. Write a log entry

## Article types — create ALL that apply
- \`modules/xxx.md\` — one per major module, directory, service, or component
- \`concepts/xxx.md\` — one per pattern, algorithm, architectural decision, or important idea
- \`entities/xxx.md\` — one per data model, class, database table, or key type
- \`flows/xxx.md\` — one per end-to-end flow showing function call chains

## Rules
- Cross-reference between articles: \`[Name](entities/name.md)\`
- "See also" section at bottom of each page
- Source attribution: \`Source: ${srcName}\` (articles can have multiple sources)
- For code: actual function names, class names, file paths, signatures
- For flows: \`funcA() → funcB() → funcC()\` with links
- Every article: 200+ words, real substance
${effectiveMode !== 'first' ? `- When this source mentions entities/concepts that already have wiki pages, UPDATE those pages to add info from this source
- Preserve existing content in updated pages — add to it, don't replace
- Do NOT skip creating new articles just because similar concepts exist — each source deserves thorough coverage` : ''}

## Return format

{
  ${effectiveMode !== 'first' ? '"updated": [\n    { "path": "entities/product.md", "title": "Product", "content": "full updated page content with info from both sources" }\n  ],' : ''}
  "created": [
    { "path": "modules/xxx.md", "title": "Module Name", "content": "# Module Name\\n\\n..." }
  ],
  ${effectiveMode === 'first' ? '"overview": "# System Overview\\n\\n...",' : ''}
  "index": "# Wiki Index\\n\\n- [Overview](overview.md) — ...\\n...",
  "logEntry": "## [${now}] ${effectiveMode === 'sync' ? 'sync' : 'ingest'} | ${srcName}\\n- ..."
}`;

    let lastProgressUpdate = 0;
    const response = await this.callClaudeWithRetry(prompt, (chars) => {
      // Update progress every 5k chars to avoid DB hammering
      if (chars - lastProgressUpdate > 5000) {
        lastProgressUpdate = chars;
        const kChars = Math.round(chars / 1000);
        updateStatus(`Claude generating wiki for ${srcName}... (${kChars}k chars)`).catch(() => {});
      }
    });
    const parsed = this.parseWikiJson(response);

    if (!parsed) throw new Error('Could not parse Claude response');

    // 4. Write results
    await updateStatus(`Writing wiki articles...`);
    let createdCount = 0;
    let updatedCount = 0;

    // Write created articles
    if (parsed.created) {
      for (const article of parsed.created) {
        const articlePath = path.join(wikiDir, article.path);
        fs.mkdirSync(path.dirname(articlePath), { recursive: true });
        fs.writeFileSync(articlePath, article.content, 'utf-8');
        createdCount++;
      }
    }

    // Write updated articles
    if (parsed.updated) {
      for (const article of parsed.updated) {
        const articlePath = path.join(wikiDir, article.path);
        fs.mkdirSync(path.dirname(articlePath), { recursive: true });
        fs.writeFileSync(articlePath, article.content, 'utf-8');
        updatedCount++;
      }
    }

    // Write overview (first ingest only)
    if (parsed.overview) {
      fs.writeFileSync(path.join(wikiDir, 'overview.md'), parsed.overview, 'utf-8');
    }

    // Write/update index.md
    if (parsed.index) {
      fs.writeFileSync(path.join(wikiDir, 'index.md'), parsed.index, 'utf-8');
    }

    // Update manifest — track which source created/updated which articles
    const createdPaths = (parsed.created ?? []).map((a: any) => a.path);
    const updatedPaths = (parsed.updated ?? []).map((a: any) => a.path);
    manifest[srcName] = {
      created: [...(manifest[srcName]?.created ?? []), ...createdPaths].filter((v: string, i: number, a: string[]) => a.indexOf(v) === i),
      updated: [...(manifest[srcName]?.updated ?? []), ...updatedPaths].filter((v: string, i: number, a: string[]) => a.indexOf(v) === i),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Append to log.md (never overwrite)
    if (parsed.logEntry) {
      const logPath = path.join(wikiDir, 'log.md');
      const existingLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '# Wiki Log\n';
      fs.writeFileSync(logPath, existingLog + '\n' + parsed.logEntry + '\n', 'utf-8');
    }

    // 5. Update source status
    await getDb().query(
      "UPDATE knowledge_sources SET status = 'compiled', last_synced = datetime('now') WHERE id = $1",
      [sourceId]
    );

    logger.info('Source ingested', { source: srcName, mode, created: createdCount, updated: updatedCount });

    // Reload agent to pick up knowledge in CLAUDE.md
    await this.reloadAgent(agentId);

    return { created: createdCount, updated: updatedCount };
  }

  /**
   * Ingest a single source (triggered by adding a source or clicking Ingest).
   */
  private async ingestSingleSource(agentId: string, sourceId: string, requestId: string): Promise<void> {
    try {
      const result = await this.ingestSource(agentId, sourceId, requestId, 'sync');
      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'done',
        articles: result.created + result.updated,
        created: result.created,
        updated: result.updated,
        summary: `Ingested: ${result.created} new, ${result.updated} updated`,
      }));
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logger.error('Ingest failed', { agentId, sourceId, requestId, error: msg });
      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'error',
        error: msg.includes('AUTH_NEEDS_LOGIN') ? 'Run `claude login` in your terminal.' : `Ingest failed: ${msg.slice(0, 200)}`,
      }));
    }
  }

  /**
   * Build Wiki — ingests only sources not yet compiled (status != 'compiled').
   * Each source is processed one by one, wiki compounds incrementally.
   */
  private async buildKnowledgeWiki(agentId: string, requestId: string): Promise<void> {
    logger.info('Building knowledge wiki', { agentId, requestId });

    try {
      const agent = await getAgentById(agentId);
      if (!agent) { await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'error', error: 'Agent not found' })); return; }

      const { getDb } = await import('@slackhive/shared');
      const fs = await import('fs');
      const path = await import('path');
      const { getAgentWorkDir } = await import('./compile-claude-md');

      // Sync check: if wiki is empty/missing but DB says sources are compiled, reset all
      const wikiDir = path.join(getAgentWorkDir(agent.slug), 'knowledge', 'wiki');
      let wikiHasArticles = false;
      try {
        if (fs.existsSync(wikiDir)) {
          const walk = (dir: string): boolean => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.isFile() && e.name.endsWith('.md')) return true;
              if (e.isDirectory() && walk(path.join(dir, e.name))) return true;
            }
            return false;
          };
          wikiHasArticles = walk(wikiDir);
        }
      } catch { /* ok */ }

      if (!wikiHasArticles) {
        // Wiki is gone — reset all compiled sources to pending for full rebuild
        await getDb().query(
          "UPDATE knowledge_sources SET status = 'pending' WHERE agent_id = $1 AND status = 'compiled'",
          [agentId]
        );
        logger.info('Wiki empty — reset all sources to pending', { agentId });
      }

      // Check total vs pending sources
      const allR = await getDb().query('SELECT count(*) as cnt FROM knowledge_sources WHERE agent_id = $1', [agentId]);
      const totalCount = parseInt(allR.rows[0]?.cnt as string ?? '0', 10);
      const pendingR = await getDb().query(
        "SELECT * FROM knowledge_sources WHERE agent_id = $1 AND status != 'compiled' ORDER BY created_at ASC",
        [agentId]
      );
      const pendingSources = pendingR.rows;

      if (pendingSources.length === 0) {
        await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'done', articles: 0, message: 'All sources already compiled.' }));
        return;
      }

      const startedAt = Date.now();

      // Smart mode: if ALL sources are pending (e.g. after a delete), clear wiki first for clean rebuild
      const isFullRebuild = pendingSources.length === totalCount;
      if (isFullRebuild) {
        await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'building', startedAt, step: 'Clearing wiki for rebuild...' }));
        const wikiDir = path.join(getAgentWorkDir(agent.slug), 'knowledge', 'wiki');
        try { fs.rmSync(wikiDir, { recursive: true, force: true }); } catch { /* ok */ }
      }

      let totalCreated = 0;
      let totalUpdated = 0;

      for (let i = 0; i < pendingSources.length; i++) {
        const src = pendingSources[i];
        await setResult(`knowledge-build:${requestId}`, JSON.stringify({
          status: 'building', startedAt,
          step: `${isFullRebuild ? 'Rebuilding' : 'Ingesting'} ${src.name} (${i + 1}/${pendingSources.length})...`,
        }));

        try {
          const result = await this.ingestSource(agentId, src.id as string, requestId, 'ingest');
          totalCreated += result.created;
          totalUpdated += result.updated;
        } catch (err) {
          logger.warn('Source ingest failed', { source: src.name, error: (err as Error).message });
        }
      }

      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'done',
        articles: totalCreated + totalUpdated,
        created: totalCreated,
        updated: totalUpdated,
        summary: `Ingested ${pendingSources.length} source(s): ${totalCreated} created, ${totalUpdated} updated`,
      }));

      logger.info('Knowledge wiki built', { agentId, sources: pendingSources.length, created: totalCreated, updated: totalUpdated });

    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logger.error('Knowledge build failed', { agentId, requestId, error: msg });
      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'error',
        error: msg.includes('AUTH_NEEDS_LOGIN') ? 'Run `claude login` in your terminal.' : `Build failed: ${msg.slice(0, 200)}`,
      }));
    }
  }

  private async analyzeMemories(agentId: string, requestId: string): Promise<void> {
    logger.info('Analyzing memories', { agentId, requestId });

    try {
      const agent = await getAgentById(agentId);
      if (!agent) {
        await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'error', error: 'Agent not found' }));
        return;
      }

      const [memories, skills] = await Promise.all([
        getAgentMemories(agentId),
        getAgentSkills(agentId),
      ]);

      if (memories.length === 0) {
        await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'done', suggestions: [] }));
        return;
      }

      const memoriesList = memories.map(m =>
        `- [${m.id}] **${m.type}**: ${m.name} — ${m.content.slice(0, 200)}`
      ).join('\n');

      const skillsList = skills.map(s => `- ${s.category}/${s.filename}`).join('\n');

      const prompt = `You are analyzing an AI agent's learned memories to suggest improvements.

CRITICAL: Your entire response must be a single JSON object. No text before or after. No markdown fences. Start with { end with }.

## Agent: ${agent.name}
${agent.description || ''}

## Current Skills
${skillsList || '(none)'}

## Current System Prompt
${agent.claudeMd || '(empty)'}

## Memories to analyze (${memories.length})
${memoriesList}

## For each memory, suggest ONE action:
- **move_to_skill**: Memory contains reusable knowledge that belongs in a skill file
- **update_prompt**: Memory contains a behavioral rule that should be in the system prompt
- **merge**: Memory overlaps with another memory and they should be combined
- **delete**: Memory is outdated, trivial, or redundant with existing skills/prompt
- **keep**: Memory is fine as-is

Return this JSON:
{
  "suggestions": [
    {
      "memoryId": "<id>",
      "action": "move_to_skill" | "update_prompt" | "merge" | "delete" | "keep",
      "reason": "<brief explanation>",
      "mergeWith": "<other memory id, only if action is merge>"
    }
  ]
}`;

      // Mark as running
      await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'running' }));

      const fullResponse = await this.callClaudeWithRetry(prompt);

      // Parse JSON from response
      let parsed: any = null;
      const strategies = [
        () => JSON.parse(fullResponse),
        () => { const m = fullResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/); return m ? JSON.parse(m[1]) : null; },
        () => { const s = fullResponse.indexOf('{'); const e = fullResponse.lastIndexOf('}'); return s >= 0 && e > s ? JSON.parse(fullResponse.slice(s, e + 1)) : null; },
      ];
      for (const strategy of strategies) {
        try { parsed = strategy(); if (parsed) break; } catch { /* try next */ }
      }
      if (!parsed) throw new Error('JSON_PARSE: Could not extract JSON from Claude response');

      await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'done', ...parsed }));
      logger.info('Memory analysis complete', { agentId, requestId, suggestions: parsed.suggestions?.length ?? 0 });

    } catch (err) {
      const message = (err as Error).message ?? String(err);
      logger.error('Memory analysis failed', { agentId, requestId, error: message });

      let userError = 'Memory analysis failed. ';
      if (message.includes('AUTH_NEEDS_LOGIN')) {
        userError = 'Run `claude login` in your terminal, then restart SlackHive.';
      } else if (message.includes('401') || message.includes('auth')) {
        userError += 'Claude not authenticated. Run `claude login` in your terminal.';
      } else if (message.includes('JSON')) {
        userError += 'Claude returned an unexpected format. Try again.';
      } else {
        userError += message;
      }

      await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'error', error: userError }));
    }
  }

  /**
   * Handles MCP authentication requests.
   * The Claude SDK's query() API doesn't support interactive OAuth.
   * Returns instructions for the user to authenticate via terminal.
   */
  private async authenticateMcp(requestId: string, mcpUrl: string, mcpName: string): Promise<void> {
    logger.info('MCP auth requested', { requestId, mcpName, mcpUrl });

    const { getDb } = await import('@slackhive/shared');
    const db = getDb();
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`mcp_auth:${requestId}`, JSON.stringify({
        status: 'action_needed',
        mcpName,
        message: `Run this command in your terminal to authenticate ${mcpName}:`,
        command: `claude mcp add --transport http ${mcpName} ${mcpUrl}`,
        hint: 'After authenticating, the token is saved automatically. Then click "Add to Catalog" to use it in SlackHive.',
      })]
    );
  }

  private async callClaudeWithRetry(prompt: string, onProgress?: (chars: number) => void): Promise<string> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const os = await import('os');

    const runQuery = async (): Promise<string> => {
      let text = '';
      for await (const msg of query({
        prompt,
        options: { maxTurns: 1, tools: [], allowedTools: [], permissionMode: 'acceptEdits', cwd: os.tmpdir() },
      })) {
        if (msg.type === 'assistant') {
          const content: any[] = (msg as any).message?.content ?? [];
          for (const block of content) {
            if (block.type === 'text') {
              text += block.text;
              if (onProgress) onProgress(text.length);
            }
          }
        }
        if (msg.type === 'result') {
          const r = (msg as any).result as string | undefined;
          if (r?.includes('authentication_error') || r?.includes('Failed to authenticate')) throw new Error(r);
          if (r) text = r;
        }
      }
      return text;
    };

    // Attempt 1: direct call
    try {
      return await runQuery();
    } catch (err1) {
      const msg1 = (err1 as Error).message ?? '';
      if (!msg1.includes('401') && !msg1.includes('auth') && !msg1.includes('credentials')) throw err1;
      logger.warn('SDK auth failed, trying Keychain sync...', { error: msg1.slice(0, 100) });
    }

    // Attempt 2: sync from macOS Keychain, then retry
    try {
      const { execSync } = await import('child_process');
      const fs = await import('fs');
      const path = await import('path');
      const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (creds) {
        const credPath = path.join(process.env.HOME || '/tmp', '.claude', '.credentials.json');
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
        fs.writeFileSync(credPath, creds, { mode: 0o600 });
        logger.info('Synced fresh credentials from Keychain');
        return await runQuery();
      }
    } catch {
      logger.warn('Keychain sync failed or not on macOS, trying token refresh...');
    }

    // Attempt 3: refresh OAuth token, then retry
    try {
      const refreshed = await ClaudeHandler.refreshOAuthToken();
      if (refreshed) {
        logger.info('OAuth token refreshed');
        return await runQuery();
      }
    } catch {
      logger.warn('Token refresh failed');
    }

    // All retries exhausted
    throw new Error('AUTH_NEEDS_LOGIN');
  }
}
