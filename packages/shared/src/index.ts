/**
 * @fileoverview Barrel export for @slackhive/shared.
 * Re-exports all types and constants used across the platform.
 *
 * @module @slackhive/shared
 */

export * from './types';
export type {
  PlatformAdapter, IncomingMessage, ThreadMessage, FileAttachment,
  MessagePayload, PlatformCredentials, SlackCredentials,
} from './platform';
export type {
  AgentBackend, BackendMessage, BackendUsage, AssistantBlock, UserBlock, AgentPrompt,
} from './agent-backend';
export {
  AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND,
  CODEX_MODEL_SETTING_KEY, DEFAULT_CODEX_MODEL, CODEX_MODELS,
  CODEX_REASONING_EFFORTS, splitCodexModel,
  CODEX_AUTH_MODE_SETTING_KEY, CLAUDE_AUTH_MODE_SETTING_KEY,
  BACKEND_DESCRIPTORS, getBackendDescriptor,
} from './backends';
export type {
  BackendId, BackendAuthMode, BackendAuthField, BackendAuthOption, BackendDescriptor,
  CodexReasoningEffort,
} from './backends';
export { initDb, getDb, closeDb, setDb } from './db/adapter';
export type { DbAdapter, DbResult, DbRow } from './db/adapter';
export { createSqliteAdapter } from './db/sqlite-adapter';
export { encrypt, decrypt } from './db/crypto';
export { getEventBus, setEventBus, closeEventBus } from './event-bus';
export type { EventBus } from './event-bus';
export { MCP_TEMPLATES, MCP_CATEGORIES, getTemplateById, getTemplatesByCategory, searchTemplates } from './mcp-templates';
export type { McpTemplate, McpEnvKey, McpCategory } from './mcp-templates';
export { PERSONA_CATALOG, getPersonaById, getPersonasByCategory, searchPersonas } from './personas';
export type { PersonaTemplate, PersonaSkillSeed, PersonaCategory } from './personas';
export { deepLinkForTask, deepLinkLabelForPlatform } from './deep-link';
export {
  upsertTask, beginActivity, finishActivity,
  beginToolCall, finishToolCall,
  listTasks, getTaskWithDetails, countInProgressByAgent,
  sweepStaleActivities,
  recordActivityUsage, getTokensByAgent, getTopUsers,
} from './db/activities-repo';
export type {
  BeginActivityInput, BeginToolCallInput, TaskListColumn, TaskListResult,
  TaskWithDetails,
  ActivityUsageInput, AgentTokenUsage, UserActivitySummary,
} from './db/activities-repo';
export {
  MODELS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_COACH_MODEL,
  COACH_MODEL_SETTING_KEY,
  DEFAULT_EVAL_JUDGE_MODEL,
  EVAL_JUDGE_MODEL_SETTING_KEY,
} from './models';
export type { ModelOption } from './models';
export { isFetchableUrl } from './wiki-source-url';
export { agentIdentityBody } from './agent-identity';
