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
  recordActivityUsage, getTokensByAgent, getTopUsers, getCurrentSessionUsage,
} from './db/activities-repo';
export type {
  BeginActivityInput, BeginToolCallInput, TaskListColumn, TaskListResult,
  TaskWithDetails,
  ActivityUsageInput, AgentTokenUsage, UserActivitySummary, CurrentSessionUsage,
} from './db/activities-repo';
