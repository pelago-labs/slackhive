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

import { App, LogLevel } from '@slack/bolt';
import type { Agent } from '@slackhive/shared';
import { type AgentEvent, getEventBus, type EventBus } from '@slackhive/shared';
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
import { registerSlackHandlers } from './slack-handler';
import { logger } from './logger';

/**
 * Represents a fully initialized running agent.
 * All resources owned by a running agent are held here for cleanup.
 */
interface RunningAgent {
  agent: Agent;
  app: App;
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
  getRunningAgent(agentId: string): { app: App; claudeHandler: import('./claude-handler').ClaudeHandler } | undefined {
    const ra = this.runningAgents.get(agentId);
    return ra ? { app: ra.app, claudeHandler: ra.claudeHandler } : undefined;
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
      if (
        !agent.slackBotToken.startsWith('xoxb-') ||
        !agent.slackAppToken.startsWith('xapp-') ||
        agent.slackBotToken.includes('placeholder') ||
        agent.slackAppToken.includes('placeholder')
      ) {
        logger.warn('Skipping agent with invalid/placeholder tokens', { agent: agent.slug });
        await updateAgentStatus(agent.id, 'stopped');
        continue;
      }
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

    // Create Slack Bolt App in Socket Mode
    const app = new App({
      token: agent.slackBotToken,
      appToken: agent.slackAppToken,
      signingSecret: agent.slackSigningSecret,
      socketMode: true,
      logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.WARN,
    });

    // Register all Slack event listeners
    registerSlackHandlers(app, agent, claudeHandler, restrictions);

    // Start the Bolt App
    await app.start();

    // Fetch and store the bot's Slack user ID for @mention construction
    try {
      const authResult = await app.client.auth.test({ token: agent.slackBotToken });
      if (authResult.user_id && authResult.user_id !== agent.slackBotUserId) {
        await updateAgentStatus(agent.id, 'running'); // Will also trigger updateAgentSlackUserId below
        const { updateAgentSlackUserId } = await import('./db');
        await updateAgentSlackUserId(agent.id, authResult.user_id as string);
        agent.slackBotUserId = authResult.user_id as string;
      }
    } catch (err) {
      logger.warn('Failed to fetch bot user ID', { agent: agent.slug, error: err });
    }

    this.runningAgents.set(agent.id, { agent, app, claudeHandler, memoryWatcher });
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

    const { agent, app, claudeHandler, memoryWatcher } = running;
    logger.info('Stopping agent', { agent: agent.slug });

    memoryWatcher.stop();
    claudeHandler.destroy();

    try {
      await app.stop();
    } catch (err) {
      logger.warn('Error stopping Bolt App', { agent: agent.slug, error: err });
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
  private async buildKnowledgeWiki(agentId: string, requestId: string): Promise<void> {
    logger.info('Building knowledge wiki', { agentId, requestId });

    try {
      const agent = await getAgentById(agentId);
      if (!agent) { await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'error', error: 'Agent not found' })); return; }

      // Load all sources
      const { getDb } = await import('@slackhive/shared');
      const r = await getDb().query('SELECT * FROM knowledge_sources WHERE agent_id = $1', [agentId]);
      const sources = r.rows;

      if (sources.length === 0) {
        await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'done', articles: 0, message: 'No sources to compile.' }));
        return;
      }

      await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'building' }));

      // Collect content from each source
      const sourceContents: { name: string; type: string; content: string }[] = [];
      const fs = await import('fs');
      const path = await import('path');
      const { execSync } = await import('child_process');

      for (const src of sources) {
        if (src.type === 'url' || src.type === 'file') {
          if (src.content) {
            sourceContents.push({ name: src.name as string, type: src.type as string, content: src.content as string });
          }
        } else if (src.type === 'repo') {
          // Clone to temp, read key files, delete
          const tmpDir = path.join('/tmp', `slackhive-repo-${src.id}`);
          try {
            // Build clone URL with PAT if private
            let cloneUrl = src.repo_url as string;
            if (src.pat_env_ref) {
              const envVars = await getAllEnvVarValues();
              const pat = envVars[src.pat_env_ref as string];
              if (pat && cloneUrl.startsWith('https://')) {
                cloneUrl = cloneUrl.replace('https://', `https://${pat}@`);
              }
            }

            const branch = (src.branch as string) || 'main';
            execSync(`git clone --depth 1 --branch ${branch} "${cloneUrl}" "${tmpDir}"`, { stdio: 'ignore', timeout: 60000 });

            // Read README
            let readme = '';
            for (const f of ['README.md', 'readme.md', 'README.rst', 'README']) {
              const p = path.join(tmpDir, f);
              if (fs.existsSync(p)) { readme = fs.readFileSync(p, 'utf-8'); break; }
            }

            // Read directory tree (top 3 levels)
            let tree = '';
            try { tree = execSync(`find "${tmpDir}" -maxdepth 3 -type f | head -100`, { encoding: 'utf-8', timeout: 5000 }); } catch { /* ok */ }
            tree = tree.replace(new RegExp(tmpDir, 'g'), '.');

            // Read key files (package.json, config, etc.)
            let keyFiles = '';
            for (const f of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'tsconfig.json', '.env.example']) {
              const p = path.join(tmpDir, f);
              if (fs.existsSync(p)) {
                const content = fs.readFileSync(p, 'utf-8').slice(0, 2000);
                keyFiles += `\n### ${f}\n\`\`\`\n${content}\n\`\`\`\n`;
              }
            }

            // Read top-level source files (first 50 .ts/.py/.go/.rs files, max 1500 chars each)
            let srcFiles = '';
            try {
              const files = execSync(`find "${tmpDir}" -maxdepth 4 -type f \\( -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" \\) | head -50`, { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').filter(Boolean);
              for (const file of files) {
                const relPath = file.replace(tmpDir + '/', '');
                if (relPath.includes('node_modules') || relPath.includes('dist/') || relPath.includes('.next/')) continue;
                const content = fs.readFileSync(file, 'utf-8').slice(0, 1500);
                srcFiles += `\n### ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`;
              }
            } catch { /* ok */ }

            sourceContents.push({
              name: src.name as string,
              type: 'repo',
              content: `# Repository: ${src.name}\n\n## README\n${readme}\n\n## Directory Structure\n\`\`\`\n${tree}\n\`\`\`\n\n## Key Config Files\n${keyFiles}\n\n## Source Files\n${srcFiles}`,
            });
          } catch (err) {
            logger.warn('Failed to clone repo', { name: src.name, error: (err as Error).message });
            sourceContents.push({ name: src.name as string, type: 'repo', content: `Failed to clone: ${(err as Error).message}` });
          } finally {
            // Always delete the temp clone
            try { execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' }); } catch { /* ok */ }
          }
        }
      }

      // Call Claude to compile wiki
      const allContent = sourceContents.map(s => `# Source: ${s.name} (${s.type})\n\n${s.content}`).join('\n\n---\n\n');

      const prompt = `You are building a knowledge wiki from the following sources. These sources may be interconnected — identify relationships and cross-references.

CRITICAL: Return ONLY a JSON object. No text before or after.

## Sources (${sourceContents.length})
${allContent.slice(0, 100000)}

## Your task
Compile these sources into structured wiki articles. Create:
- An index page listing all articles
- Concept articles for key ideas/patterns
- Module/component articles for code structures
- Cross-reference articles showing how things connect
- A system overview if multiple repos/sources are related

Return JSON:
{
  "articles": [
    {
      "path": "index.md",
      "title": "Knowledge Base Index",
      "content": "# Knowledge Base\\n\\n- [Overview](overview.md)\\n..."
    },
    {
      "path": "overview.md",
      "title": "System Overview",
      "content": "# System Overview\\n\\n..."
    }
  ],
  "summary": "<one line summary of what was compiled>"
}

Guidelines:
- Create 5-20 articles depending on source complexity
- Use markdown with headers, code blocks, lists
- Cross-reference between articles using relative links
- Be comprehensive but concise
- For repos: focus on architecture, key modules, patterns, APIs
- For docs/URLs: summarize key concepts and reference points`;

      const fullResponse = await this.callClaudeWithRetry(prompt);

      // Parse JSON
      let parsed: any = null;
      for (const strategy of [
        () => JSON.parse(fullResponse),
        () => { const m = fullResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/); return m ? JSON.parse(m[1]) : null; },
        () => { const s = fullResponse.indexOf('{'); const e = fullResponse.lastIndexOf('}'); return s >= 0 && e > s ? JSON.parse(fullResponse.slice(s, e + 1)) : null; },
      ]) {
        try { parsed = strategy(); if (parsed?.articles) break; } catch { /* try next */ }
      }

      if (!parsed?.articles) {
        await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'error', error: 'Could not parse wiki articles from Claude response' }));
        return;
      }

      // Write wiki articles to agent workspace
      const { getAgentWorkDir } = await import('./compile-claude-md');
      const wikiDir = path.join(getAgentWorkDir(agent.slug), 'knowledge', 'wiki');
      fs.mkdirSync(wikiDir, { recursive: true });

      // Clear old wiki
      try {
        const existing = fs.readdirSync(wikiDir, { recursive: true }) as string[];
        // Simple clear: remove all .md files
        for (const file of existing) {
          const fullPath = path.join(wikiDir, file);
          if (fs.statSync(fullPath).isFile()) fs.unlinkSync(fullPath);
        }
      } catch { /* dir might not exist yet */ }

      // Write new articles
      for (const article of parsed.articles) {
        const articlePath = path.join(wikiDir, article.path);
        fs.mkdirSync(path.dirname(articlePath), { recursive: true });
        fs.writeFileSync(articlePath, article.content, 'utf-8');
      }

      // Update source statuses
      for (const src of sources) {
        await getDb().query(
          "UPDATE knowledge_sources SET status = 'compiled', last_synced = datetime('now') WHERE id = $1",
          [src.id]
        );
      }

      const totalWords = parsed.articles.reduce((sum: number, a: any) => sum + (a.content?.split(/\s+/).length ?? 0), 0);

      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'done',
        articles: parsed.articles.length,
        words: totalWords,
        summary: parsed.summary ?? `Compiled ${parsed.articles.length} articles from ${sourceContents.length} sources`,
      }));

      logger.info('Knowledge wiki built', { agentId, articles: parsed.articles.length, words: totalWords });

      // Reload agent to pick up knowledge in CLAUDE.md
      await this.reloadAgent(agentId);

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

  private async callClaudeWithRetry(prompt: string): Promise<string> {
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
            if (block.type === 'text') text += block.text;
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
