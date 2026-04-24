/**
 * @fileoverview Shared TypeScript types for the Slack Claude Code Agent Team platform.
 *
 * These types are used across all packages (web, runner) to ensure type safety
 * and consistency. They mirror the Postgres database schema and define the
 * contracts for Redis pub/sub events and REST API requests/responses.
 *
 * @module @slackhive/shared/types
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
  /** Inline environment variables to inject into the subprocess. Values are masked in API responses. */
  env?: Record<string, string>;
  /**
   * Maps subprocess env var name → key in the platform env_vars store.
   * Resolved by the runner at agent start time. Not masked — these are key names, not secrets.
   * Example: { "DATABASE_URL": "REDSHIFT_DATABASE_URL" }
   */
  envRefs?: Record<string, string>;
  /**
   * Inline TypeScript source code for this MCP server.
   * When present, the runner writes this to disk and executes it with `tsx`.
   * command/args are ignored when tsSource is set.
   */
  tsSource?: string;
}

/**
 * Configuration for a Server-Sent Events (SSE) MCP server.
 * Used for remote MCP servers that stream over HTTP.
 */
export interface McpSseConfig {
  type?: 'sse';
  /** The SSE endpoint URL. */
  url: string;
  /** HTTP headers to include in requests (e.g., Authorization). */
  headers?: Record<string, string>;
  /** Maps header name → key in platform env_vars store (resolved by runner). */
  envRefs?: Record<string, string>;
}

/**
 * Configuration for an HTTP-based MCP server.
 * Used for remote MCP servers with HTTP transport.
 */
export interface McpHttpConfig {
  type?: 'http';
  /** The HTTP endpoint URL. */
  url: string;
  /** HTTP headers to include in requests (e.g., Authorization). */
  headers?: Record<string, string>;
  /** Maps header name → key in platform env_vars store (resolved by runner). */
  envRefs?: Record<string, string>;
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
  /** Populated from platform_integrations at query time — not stored on agents table. */
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackBotUserId?: string;
  /**
   * Derived presence flag for list endpoints that strip the raw credentials.
   * True when an active slack platform_integrations row exists for this agent.
   */
  hasSlackCreds?: boolean;
  /**
   * The Claude model to use for this agent.
   * @default "claude-opus-4-6"
   */
  model: string;
  /** Current runtime status of the agent's Slack bot process. */
  status: AgentStatus;
  /**
   * Whether this agent should auto-start when the runner starts.
   * Set to false only when the user explicitly stops the agent.
   * Runner restarts never change this value.
   */
  enabled: boolean;
  /**
   * Whether this is a boss agent.
   * Multiple boss agents are supported; each manages its own team of specialists.
   * A boss agent's CLAUDE.md registry is auto-generated from agents that report to it.
   */
  isBoss: boolean;
  /**
   * When true (default), each assistant text block is posted to the platform immediately.
   * When false, only the final answer is sent as a single message.
   * @default true
   */
  verbose: boolean;
  /** UUIDs of boss agents this agent reports to. Empty array if this agent is a boss. */
  reportsTo: string[];
  /**
   * The agent's main CLAUDE.md instruction file content.
   * Written to the session working directory on each session start.
   * Skills are written separately to .claude/commands/ as slash commands.
   */
  claudeMd: string;
  /** Username of the user who created this agent. 'system' for seeded agents. */
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Human-readable reason for the most recent start failure. Set by the runner
   * when `status` transitions to 'error'; cleared when the agent starts
   * successfully. Shown under the status chip on the agent detail page so the
   * user immediately sees *why* an agent isn't running.
   */
  lastError?: string | null;
  /**
   * UUID of the runner process that last wrote this agent's status. Lets the
   * UI (and a future owning-runner check) distinguish the authoritative
   * writer from a stray/legacy runner sharing the same DB.
   */
  runnerId?: string | null;
  /**
   * ISO timestamp of the last liveness write from the owning runner. The
   * runner bumps this every 15s for agents it's actively running. If the
   * read side sees a `running` status with a heartbeat older than ~45s, it
   * renders the status as `stale` instead of trusting the flag.
   */
  lastHeartbeat?: string | null;
  /**
   * Derived at read time from `status` + `lastHeartbeat` age. Not persisted.
   * `stale` means the DB says `running` but no runner heartbeat has landed
   * recently — the owning process likely crashed.
   */
  liveStatus?: AgentStatus | 'stale';
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
 * A named secret stored in the platform env_vars table.
 * Values are write-only — never returned via the API after creation.
 */
export interface EnvVar {
  key: string;
  description?: string;
  updatedAt: Date;
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
 * Per-agent channel restrictions.
 * If allowedChannels is non-empty, the bot only responds in those channels.
 * Empty allowedChannels means unrestricted (responds everywhere).
 * Bot-initiated outbound DMs (scheduled jobs) bypass this restriction entirely.
 */
export interface Restriction {
  id: string;
  agentId: string;
  /** Slack channel IDs the bot is allowed to respond in. Empty = unrestricted. */
  allowedChannels: string[];
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
  /** Hash of MCP config at session creation — used to detect config changes requiring session invalidation. */
  mcpHash?: string;
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

/** Event to reload the job scheduler (jobs created/updated/deleted). */
export interface JobsReloadEvent {
  type: 'reload-jobs';
}

/** Union of all lifecycle events published on Redis. */
export type AgentEvent = AgentReloadEvent | AgentStartEvent | AgentStopEvent | JobsReloadEvent;

// =============================================================================
// Coach (interactive instruction tuning) types
// =============================================================================

/**
 * A single change the coach wants to make to the agent's claude.md, a skill,
 * or a memory row. Surfaced in the chat UI as an approval card — never
 * auto-applied (except during wizard bootstrap).
 */
export type CoachProposal =
  | {
      kind: 'claude-md';
      /** Full replacement content for agents.claude_md. */
      content: string;
      rationale: string;
      /** Server-assigned id, unique within a session. */
      id: string;
      status: 'pending' | 'applied' | 'rejected';
    }
  | {
      kind: 'skill';
      category: string;
      filename: string;
      action: 'create' | 'update' | 'delete';
      /** New/updated skill body. Omit for delete. */
      content?: string;
      rationale: string;
      id: string;
      status: 'pending' | 'applied' | 'rejected';
    }
  | {
      kind: 'memory';
      /** Target memory row id. Required for `update` and `delete`; unset on `create`. */
      memoryId?: string;
      /** Name of the memory being touched — shown on the approval card. */
      memoryName: string;
      action: 'create' | 'update' | 'delete';
      /**
       * Memory type — required for `create`, optional on `update` (lets the Coach
       * retype a mis-categorized memory). Ignored on delete.
       */
      memoryType?: 'user' | 'feedback' | 'project' | 'reference';
      /** New content for create/update; omit for delete. */
      content?: string;
      rationale: string;
      id: string;
      status: 'pending' | 'applied' | 'rejected';
    }
  | {
      /**
       * A change to a file-type knowledge source — verbatim reference content
       * the agent reads at runtime from `knowledge/sources/<name>.md`. The
       * coach proposes create/update/delete; human approval applies via the
       * knowledge-sources CRUD routes. The wiki itself is NOT re-synced from
       * this flow — the user is prompted to sync from the Knowledge tab so
       * they can see progress on the tool that owns it.
       */
      kind: 'file-source';
      action: 'create' | 'update' | 'delete';
      /** Target source row id — required for update/delete, unset on create. */
      sourceId?: string;
      /** Display name — shown on the approval card; also the DB `name` column on create. */
      name: string;
      /** Verbatim text to store (create/update). Omit for delete. Capped at 1 MB. */
      content?: string;
      rationale: string;
      id: string;
      status: 'pending' | 'applied' | 'rejected';
    };

/** One message in the coach conversation. */
export interface CoachMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Plain text shown in the bubble. Assistant messages may also carry proposals. */
  text: string;
  /** Compact record of tools Claude invoked during this turn (for UI chips). */
  toolCalls?: { name: string; input: Record<string, unknown>; ok: boolean }[];
  proposals?: CoachProposal[];
  createdAt: string;
  /**
   * Assistant messages only — set to true while the runner is still producing
   * this turn. Lets the UI show a "drafting" indicator when the user arrives
   * before the turn has finished (e.g. wizard bootstrap).
   */
  inProgress?: boolean;
}

/** Persisted coach conversation for one agent. */
export interface CoachSession {
  agentId: string;
  /** SDK session id used for resume on subsequent turns. */
  sdkSessionId?: string;
  messages: CoachMessage[];
  updatedAt: string;
}

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
  'files:write',
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
  /** Platform credentials (stored in platform_integrations table). */
  platform?: string;
  platformCredentials?: Record<string, string>;
  model?: string;
  isBoss?: boolean;
  reportsTo?: string[];
  mcpServerIds?: string[];
  skillTemplate?: SkillTemplate;
}

export interface UpdateAgentRequest {
  name?: string;
  persona?: string;
  description?: string;
  /** Update platform credentials. */
  platformCredentials?: Record<string, string>;
  model?: string;
  isBoss?: boolean;
  reportsTo?: string[];
  verbose?: boolean;
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
 * Request body for updating an agent's channel restrictions.
 * Used in PUT /api/agents/[id]/restrictions.
 */
export interface UpdateRestrictionsRequest {
  allowedChannels: string[];
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

// =============================================================================
// Knowledge Base
// =============================================================================

/** Source type for knowledge base. */
export type KnowledgeSourceType = 'url' | 'file' | 'repo';

/** Status of a knowledge source. */
export type KnowledgeSourceStatus = 'pending' | 'building' | 'compiled' | 'error';

/**
 * A knowledge source that feeds into the agent's wiki.
 * Sources are compiled by Claude into structured wiki articles.
 */

/** Platform integration — connects an agent to a messaging platform. */
export interface PlatformIntegration {
  id: string;
  agentId: string;
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'teams';
  credentials: Record<string, string>;
  botUserId?: string;
  enabled: boolean;
  createdAt: Date;
}

export interface KnowledgeSource {
  id: string;
  agentId: string;
  type: KnowledgeSourceType;
  name: string;
  /** URL for 'url' type sources. */
  url?: string;
  /** Git repo URL for 'repo' type sources. */
  repoUrl?: string;
  /** Branch to track (default: 'main'). */
  branch?: string;
  /** Env var key referencing a PAT for private repos. */
  patEnvRef?: string;
  /** Cron schedule for auto-sync. */
  syncCron?: string;
  /** Raw content (for url/file types, not repos). */
  content?: string;
  status: KnowledgeSourceStatus;
  wordCount: number;
  lastSynced?: string;
  createdAt: Date;
}

// =============================================================================
// Scheduled Jobs
// =============================================================================

/** Delivery target type for scheduled job results. */
export type JobTargetType = 'channel' | 'dm';

/** Execution status of a job run. */
export type JobRunStatus = 'running' | 'success' | 'error';

/**
 * A recurring task executed by the boss agent on a cron schedule.
 * The boss receives the prompt, may delegate to specialists,
 * and the result is posted to the target channel or DM.
 */
export interface ScheduledJob {
  id: string;
  /** The agent that executes this job. */
  agentId: string;
  name: string;
  /** The prompt sent to the agent on each run. */
  prompt: string;
  /** Cron expression (e.g. "0 8 * * *" for daily at 8am). */
  cronSchedule: string;
  /** Whether to post to a channel or send a DM. */
  targetType: JobTargetType;
  /** Slack channel ID or user ID to deliver results to. */
  targetId: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A single execution record for a scheduled job.
 */
export interface JobRun {
  id: string;
  jobId: string;
  startedAt: Date;
  finishedAt?: Date;
  status: JobRunStatus;
  /** Truncated output from the job (max ~2000 chars). */
  output?: string;
  /** Error message if the job failed. */
  error?: string;
}

/**
 * Request body for creating a new scheduled job.
 */
export interface CreateJobRequest {
  agentId: string;
  name: string;
  prompt: string;
  cronSchedule: string;
  targetType?: JobTargetType;
  targetId: string;
  enabled?: boolean;
}

/**
 * Request body for updating an existing scheduled job.
 */
export interface UpdateJobRequest {
  agentId?: string;
  name?: string;
  prompt?: string;
  cronSchedule?: string;
  targetType?: JobTargetType;
  targetId?: string;
  enabled?: boolean;
}

// =============================================================================
// Version Control — Agent Snapshots
// =============================================================================

/**
 * A single skill entry stored inside an agent snapshot.
 * UUID is omitted — re-generated via upsertSkill on restore.
 */
export interface SnapshotSkill {
  category: string;
  filename: string;
  content: string;
  sort_order: number;
}

/** What triggered the snapshot creation. */
export type SnapshotTrigger = 'skills' | 'permissions' | 'mcps' | 'claude-md' | 'restrictions' | 'manual';

/**
 * A point-in-time snapshot of an agent's full configuration.
 * Immutable — never updated after creation.
 *
 * - `skillsJson` — full skills array at snapshot time
 * - `compiledMd` — skills-only CLAUDE.md (no memories section)
 * - `createdBy` — username of the person whose save triggered this snapshot
 */
export interface AgentSnapshot {
  id: string;
  agentId: string;
  label?: string;
  trigger: SnapshotTrigger;
  /** Username of the person who triggered the snapshot (from session). */
  createdBy: string;
  skillsJson: SnapshotSkill[];
  allowedTools: string[];
  deniedTools: string[];
  mcpIds: string[];
  compiledMd: string;
  allowedChannels: string[];
  createdAt: Date;
}

/**
 * Request body for creating a manual snapshot.
 * Used in POST /api/agents/[id]/snapshots.
 */
export interface CreateSnapshotRequest {
  label?: string;
}

// =============================================================================
// Activity Dashboard — tasks, activities, tool calls
// =============================================================================

/** Messaging platform on which a task lives. Reuses the PlatformIntegration literal. */
export type Platform = 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'teams';

/** Lifecycle state of one agent's work inside a task. */
export type ActivityStatus = 'in_progress' | 'done' | 'error';

/** What triggered an activity — a human user or a delegating agent. */
export type ActivityInitiatorKind = 'user' | 'agent';

/** Lifecycle state of one tool invocation inside an activity. */
export type ToolCallStatus = 'in_progress' | 'ok' | 'error';

/**
 * A task = one conversation thread on a messaging platform.
 * For Slack: `{channel_id}:{thread_ts}` identifies it.
 * Every agent that replies in the thread contributes an `Activity` to this task.
 */
export interface Task {
  id: string;
  platform: Platform;
  channelId: string;
  threadTs: string;
  initiatorUserId?: string;
  initiatorHandle?: string;
  initialAgentId?: string;
  summary?: string;
  startedAt: string;
  lastActivityAt: string;
  activityCount: number;
}

/** One agent's turn inside a task — the unit that the runner writes. */
export interface Activity {
  id: string;
  taskId: string;
  agentId: string;
  platform: Platform;
  initiatorKind: ActivityInitiatorKind;
  initiatorUserId?: string;
  messageRef?: string;
  messagePreview?: string;
  startedAt: string;
  finishedAt?: string;
  status: ActivityStatus;
  error?: string;
  toolCallCount: number;
}

/** One tool invocation captured from the SDK stream. */
export interface ToolCall {
  id: string;
  activityId: string;
  toolName: string;
  argsPreview?: string;
  startedAt: string;
  finishedAt?: string;
  status: ToolCallStatus;
  resultPreview?: string;
}

/** Filter for `listTasks` queries. */
export interface ActivityFilter {
  agentId?: string;
  userId?: string;
  status?: 'active' | 'recent' | 'errored';
  since?: string;
  /**
   * Restrict results to tasks with at least one activity from one of these
   * agent IDs. `undefined` = no restriction (admin view); empty array = the
   * user has access to nothing, so the query returns zero rows.
   */
  accessibleAgentIds?: string[];
}
