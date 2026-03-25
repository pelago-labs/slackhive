/**
 * @fileoverview Shared TypeScript types for the Slack Claude Code Agent Team platform.
 *
 * These types are used across all packages (web, runner) to ensure type safety
 * and consistency. They mirror the Postgres database schema and define the
 * contracts for Redis pub/sub events and REST API requests/responses.
 *
 * @module @slack-agent-team/shared/types
 */

// =============================================================================
// MCP Server Configuration Types
// =============================================================================

/**
 * Configuration for a stdio-based MCP server (subprocess).
 * The most common type — spawns a local process.
 */
export interface McpStdioConfig {
  /** The command to execute (e.g., "node", "uvx", "python"). */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Environment variables to inject into the subprocess. */
  env?: Record<string, string>;
}

/**
 * Configuration for a Server-Sent Events (SSE) MCP server.
 * Used for remote MCP servers that stream over HTTP.
 */
export interface McpSseConfig {
  /** The SSE endpoint URL. */
  url: string;
  /** HTTP headers to include in requests (e.g., Authorization). */
  headers?: Record<string, string>;
}

/**
 * Configuration for an HTTP-based MCP server.
 * Used for remote MCP servers with HTTP transport.
 */
export interface McpHttpConfig {
  /** The HTTP endpoint URL. */
  url: string;
  /** HTTP headers to include in requests (e.g., Authorization). */
  headers?: Record<string, string>;
}

/** Union of all supported MCP server configuration shapes. */
export type McpServerConfig = McpStdioConfig | McpSseConfig | McpHttpConfig;

/** Transport type of an MCP server. */
export type McpServerType = 'stdio' | 'sse' | 'http';

// =============================================================================
// Database Model Types
// =============================================================================

/** Agent status values reflecting the runtime state of the Slack bot. */
export type AgentStatus = 'running' | 'stopped' | 'error';

/**
 * A registered agent in the platform.
 * Each agent maps to one Slack bot (one set of Slack credentials) and runs
 * as an independent Bolt application inside the runner service.
 */
export interface Agent {
  /** UUID primary key. */
  id: string;
  /**
   * URL-safe identifier used in filesystem paths and UI routes.
   * @example "gilfoyle", "boss", "data-analyst"
   */
  slug: string;
  /** Human-readable display name shown in the UI and Slack. */
  name: string;
  /**
   * The agent's persona/identity description injected into its CLAUDE.md.
   * Defines how the agent presents itself and what it specializes in.
   */
  persona?: string;
  /**
   * Short description of what this agent does.
   * Used by the boss agent to decide when to delegate to this agent.
   * @example "Data warehouse NLQ, Redshift queries, business metrics"
   */
  description?: string;
  /** Slack bot token (xoxb-...) for sending messages. */
  slackBotToken: string;
  /** Slack app-level token (xapp-...) for Socket Mode connection. */
  slackAppToken: string;
  /** Slack signing secret for request verification. */
  slackSigningSecret: string;
  /**
   * The bot's Slack user ID (e.g., U12345678).
   * Populated automatically on first connection via auth.test API.
   * Used by the boss agent to construct proper @mentions.
   */
  slackBotUserId?: string;
  /**
   * The Claude model to use for this agent.
   * @default "claude-opus-4-6"
   */
  model: string;
  /** Current runtime status of the agent's Slack bot process. */
  status: AgentStatus;
  /**
   * Whether this is the boss agent.
   * There should only be one boss agent per platform instance.
   * The boss knows all other agents and delegates by @mentioning them in threads.
   */
  isBoss: boolean;
  /** UUID of the boss agent this agent reports to. Null if this agent IS the boss. */
  reportsTo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A globally available MCP server in the platform catalog.
 * MCP servers are defined once at the platform level and can be
 * assigned to any agent via the agent_mcps join table.
 */
export interface McpServer {
  /** UUID primary key. */
  id: string;
  /**
   * Unique name used to identify the server and construct tool names.
   * Tool names follow the pattern: mcp__{name}__{toolName}
   * @example "redshift-mcp", "openmetadata"
   */
  name: string;
  /** Transport type of the MCP server. */
  type: McpServerType;
  /** Transport-specific configuration (command/args/env or url/headers). */
  config: McpServerConfig;
  /** Human-readable description of what this MCP server provides. */
  description?: string;
  /** Whether this server is available for agents to use. */
  enabled: boolean;
  createdAt: Date;
}

/**
 * Join record linking an agent to an MCP server from the catalog.
 * When an agent is started, all its associated MCP servers are loaded
 * and passed to the Claude Code SDK.
 */
export interface AgentMcp {
  agentId: string;
  mcpId: string;
}

/**
 * Memory type classification, following the auto-memory system conventions.
 *
 * - `user`: Information about the user's role, goals, and preferences.
 * - `feedback`: Guidance from users about how the agent should behave.
 * - `project`: Information about ongoing work, goals, and context.
 * - `reference`: Pointers to external resources and systems.
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/**
 * A skill file for an agent.
 * Skills are markdown documents that define an agent's knowledge, behavior,
 * and capabilities. They are compiled in order into a single CLAUDE.md file
 * that the Claude Code SDK reads as the agent's system prompt.
 *
 * Skills are organized by category (e.g., "00-core", "01-knowledge") and
 * sorted by sort_order within each category.
 */
export interface Skill {
  /** UUID primary key. */
  id: string;
  agentId: string;
  /**
   * Category folder name, used for organization and compile order.
   * @example "00-core", "01-schema-knowledge", "02-sql-patterns"
   */
  category: string;
  /**
   * Filename within the category.
   * @example "identity.md", "workflow.md"
   */
  filename: string;
  /** Full markdown content of the skill file. */
  content: string;
  /** Sort order within the category (lower = compiled first). */
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tool permissions for an agent.
 * Controls which Claude Code SDK built-in tools and MCP tools the agent
 * can use. For security, agents should only have access to what they need.
 */
export interface Permission {
  /** UUID primary key. */
  id: string;
  agentId: string;
  /**
   * Explicitly allowed tools. MCP tools follow the pattern:
   * mcp__{serverName}__{toolName}
   * Built-in tools: "Read", "Write", "Edit", "Bash", etc.
   */
  allowedTools: string[];
  /**
   * Explicitly denied tools. Overrides allowedTools.
   * Useful for blocking dangerous built-in tools (e.g., "Bash", "Write").
   */
  deniedTools: string[];
  updatedAt: Date;
}

/**
 * A memory entry for an agent.
 *
 * Memory is the primary mechanism by which agents learn from interactions.
 * During a conversation, the Claude Code SDK writes memory files to the agent's
 * working directory. The runner watches for these writes and persists them to
 * the database. On restart, memories are re-materialized to disk so the agent
 * retains everything it has learned.
 *
 * Memory entries are compiled into the agent's CLAUDE.md so they are always
 * in context, enabling continuous improvement across all conversations.
 */
export interface Memory {
  /** UUID primary key. */
  id: string;
  agentId: string;
  /** Category of memory, used to structure the CLAUDE.md memory section. */
  type: MemoryType;
  /**
   * Short name/title for this memory entry.
   * @example "user_is_data_scientist", "avoid_mocking_database"
   */
  name: string;
  /**
   * Full markdown content of the memory.
   * Should include frontmatter (name, description, type) following
   * the auto-memory system format.
   */
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A persisted conversation session mapping Slack thread to Claude session.
 * Enables conversation continuity — when a user returns to a thread, the
 * agent resumes from where it left off using the Claude Code SDK's resume feature.
 */
export interface Session {
  /** UUID primary key. */
  id: string;
  agentId: string;
  /**
   * Composite key identifying the Slack conversation context.
   * Format: `{userId}-{channelId}-{threadTs|'direct'}`
   */
  sessionKey: string;
  /**
   * The Claude Code SDK session ID returned from the first `system:init` message.
   * Passed as `options.resume` in subsequent queries to continue the conversation.
   */
  claudeSessionId?: string;
  /** Last time this session had activity. Used for cleanup of stale sessions. */
  lastActivity: Date;
}

// =============================================================================
// Runtime Types (not stored in DB)
// =============================================================================

/**
 * In-memory representation of an active conversation session in the runner.
 * Augments the persisted Session with runtime state.
 */
export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  /** Claude Code SDK session ID for resuming conversations. */
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
}

// =============================================================================
// Redis Pub/Sub Event Types
// =============================================================================

/**
 * Event to reload (stop + recompile + restart) an agent.
 * Published by the web API when an agent's config, skills, or MCPs change.
 */
export interface AgentReloadEvent {
  type: 'reload';
  agentId: string;
}

/** Event to start a stopped agent. */
export interface AgentStartEvent {
  type: 'start';
  agentId: string;
}

/** Event to stop a running agent. */
export interface AgentStopEvent {
  type: 'stop';
  agentId: string;
}

/** Union of all agent lifecycle events published on Redis. */
export type AgentEvent = AgentReloadEvent | AgentStartEvent | AgentStopEvent;

/** Redis channel name for agent lifecycle events. */
export const AGENT_EVENTS_CHANNEL = 'agent:events';

// =============================================================================
// Slack App Manifest Type
// =============================================================================

/**
 * Slack app manifest structure for programmatic app creation.
 * Generated by the platform during the agent onboarding wizard.
 * @see https://api.slack.com/reference/manifests
 */
export interface SlackAppManifest {
  display_information: {
    name: string;
    description?: string;
    background_color?: string;
    long_description?: string;
  };
  features: {
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
    app_home?: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
  };
  oauth_config: {
    scopes: {
      bot: string[];
    };
  };
  settings: {
    event_subscriptions: {
      bot_events: string[];
    };
    interactivity: {
      is_enabled: boolean;
    };
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
    org_deploy_enabled: boolean;
  };
}

/** Default Slack OAuth scopes required for all agents. */
export const DEFAULT_SLACK_BOT_SCOPES: string[] = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'chat:write.public',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:read',
  'reactions:read',
  'reactions:write',
  'users:read',
];

/** Additional scopes required specifically by the boss agent. */
export const BOSS_ADDITIONAL_SCOPES: string[] = [
  'channels:read',
  'groups:read',
];

// =============================================================================
// API Request / Response Types
// =============================================================================

/**
 * Request body for creating a new agent.
 * Used in POST /api/agents.
 */
export interface CreateAgentRequest {
  slug: string;
  name: string;
  persona?: string;
  description?: string;
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  model?: string;
  isBoss?: boolean;
  /** UUID of the boss agent this agent reports to. */
  reportsTo?: string | null;
  /** IDs of MCP servers from the catalog to assign to this agent. */
  mcpServerIds?: string[];
  /** Skill template to bootstrap: blank | data-analyst | writer | developer */
  skillTemplate?: SkillTemplate;
}

/**
 * Request body for updating an existing agent's configuration.
 * Used in PATCH /api/agents/[id].
 */
export interface UpdateAgentRequest {
  name?: string;
  persona?: string;
  description?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  model?: string;
}

/**
 * Request body for creating or updating a global MCP server.
 * Used in POST/PATCH /api/mcps.
 */
export interface UpsertMcpServerRequest {
  name: string;
  type: McpServerType;
  config: McpServerConfig;
  description?: string;
  enabled?: boolean;
}

/**
 * Request body for updating an agent's tool permissions.
 * Used in PUT /api/agents/[id]/permissions.
 */
export interface UpdatePermissionsRequest {
  allowedTools: string[];
  deniedTools: string[];
}

/**
 * Request body for creating or updating a skill file.
 * Used in PUT /api/agents/[id]/skills/[category]/[filename].
 */
export interface UpsertSkillRequest {
  content: string;
  sortOrder?: number;
}

/**
 * Request body for creating or updating a memory entry.
 * Used in POST/PATCH /api/agents/[id]/memories.
 */
export interface UpsertMemoryRequest {
  type: MemoryType;
  name: string;
  content: string;
}

// =============================================================================
// Skill Templates
// =============================================================================

/**
 * Built-in skill templates for bootstrapping new agents.
 * - `blank`: Minimal identity skill only.
 * - `data-analyst`: SQL/data analysis skills (based on NLQ bot).
 * - `writer`: Content generation and summarization skills.
 * - `developer`: Code review and development assistance skills.
 */
export type SkillTemplate = 'blank' | 'data-analyst' | 'writer' | 'developer';
