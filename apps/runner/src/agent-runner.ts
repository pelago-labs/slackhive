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
import { createClient, type RedisClientType } from 'redis';
import type { Agent } from '@slackhive/shared';
import { AGENT_EVENTS_CHANNEL, type AgentEvent } from '@slackhive/shared';
import { JobScheduler } from './job-scheduler';
import {
  getAllAgents,
  getAgentById,
  getAgentMcpServers,
  getAgentPermissions,
  getAgentRestrictions,
  getAgentMemories,
  getAllEnvVarValues,
  updateAgentStatus,
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

  /** Redis subscriber client for hot-reload events. */
  private redisSubscriber: RedisClientType | null = null;

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

    await this.connectRedis();
    await this.loadAllAgents();
    await this.jobScheduler.start();
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

    // Stop job scheduler
    await this.jobScheduler.stop();

    // Stop all agents concurrently
    const stopPromises = Array.from(this.runningAgents.keys()).map((id) =>
      this.stopAgent(id).catch((err) =>
        logger.warn('Error stopping agent during shutdown', { agentId: id, error: err.message })
      )
    );
    await Promise.all(stopPromises);

    if (this.redisSubscriber) {
      await this.redisSubscriber.unsubscribe();
      await this.redisSubscriber.disconnect();
      this.redisSubscriber = null;
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
  // Redis pub/sub
  // ===========================================================================

  /**
   * Connects to Redis and subscribes to agent lifecycle events.
   *
   * @returns {Promise<void>}
   * @throws {Error} If REDIS_URL is not set or connection fails.
   */
  private async connectRedis(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      logger.warn('REDIS_URL not set — hot reload disabled');
      return;
    }

    this.redisSubscriber = createClient({ url: redisUrl }) as RedisClientType;

    this.redisSubscriber.on('error', (err) => {
      logger.warn('Redis subscriber error', { error: err.message });
    });

    await this.redisSubscriber.connect();

    await this.redisSubscriber.subscribe(AGENT_EVENTS_CHANNEL, (message) => {
      this.handleAgentEvent(message);
    });

    logger.info('Redis subscriber connected', { channel: AGENT_EVENTS_CHANNEL });
  }

  /**
   * Handles an agent lifecycle event received from Redis.
   *
   * @param {string} rawMessage - JSON-encoded AgentEvent.
   * @returns {void}
   */
  private handleAgentEvent(rawMessage: string): void {
    let event: AgentEvent;
    try {
      event = JSON.parse(rawMessage) as AgentEvent;
    } catch {
      logger.warn('Received malformed agent event', { rawMessage });
      return;
    }

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
}
