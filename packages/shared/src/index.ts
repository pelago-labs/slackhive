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
export { PAYLOAD_BREAK } from './platform';
export type {
  AgentBackend, BackendMessage, BackendUsage, AssistantBlock, UserBlock, AgentPrompt,
} from './agent-backend';
export {
  AGENT_BACKEND_SETTING_KEY, DEFAULT_AGENT_BACKEND,
  CODEX_MODEL_SETTING_KEY, DEFAULT_CODEX_MODEL, LIGHT_CODEX_MODEL, CODEX_MODELS,
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
export { backupDatabase, listBackups, pruneBackups, resolveBackupPath, backupsDir, databasePath, BACKUP_NAME_RE } from './db/backup';
export type { BackupInfo } from './db/backup';
export { wrapRecoveryKey, unwrapRecoveryKey, assertStrongRecoveryPassword, MIN_RECOVERY_PASSWORD_LENGTH } from './db/recovery-key';
export type { RecoveryBlob } from './db/recovery-key';
export { getSessionTrace, getAgentRollup, getInsightsRollup, getSessionSummaries, getSensitiveEvents, getSensitiveFlows, getFeedbackCountsForTasks, getToolStats, pruneTraceData } from './db/trace-repo';
export type {
  SessionTrace, SessionRollup, TraceTurn, TraceSpan, SpanKind, ModelUsage, TurnFeedback, AgentRollup,
  InsightsRollup, InsightsFilter, SessionSummary,
  SensitiveEvent, SensitiveFeedFilter, SensitiveFlow, ToolStat, ToolErrorGroup,
} from './db/trace-repo';
export { encrypt, decrypt } from './db/crypto';
export { getEventBus, setEventBus, closeEventBus } from './event-bus';
export type { EventBus } from './event-bus';
export { MCP_TEMPLATES, MCP_CATEGORIES, getTemplateById, getTemplatesByCategory, searchTemplates } from './mcp-templates';
export type { McpTemplate, McpEnvKey, McpCategory } from './mcp-templates';
export { PERSONA_CATALOG, getPersonaById, getPersonasByCategory, searchPersonas } from './personas';
export type { PersonaTemplate, PersonaSkillSeed, PersonaCategory } from './personas';
export { deepLinkForTask, deepLinkLabelForPlatform } from './deep-link';
export {
  detectSensitive, detectInText, mergeHits, markSensitive, markSensitiveWith, humanizeTag,
  SENS_COLOR, CAT_LABEL, SCAN_CAP,
  severityForTag, maxSeverity, SEVERITY_RANK, SEVERITY_COLOR, egressKind, redactSensitive,
} from './sensitivity';
export type { SensitiveHit, SensitiveCategory, SensSegment, SensScope, Severity, RedactionLevel, ExtraMark } from './sensitivity';
export {
  upsertTask, beginActivity, finishActivity,
  beginToolCall, finishToolCall,
  listTasks, getTaskWithDetails, countInProgressByAgent,
  sweepStaleActivities,
  recordActivityUsage, getTokensByAgent, getTopUsers,
  recordMessageFeedback, getFeedbackReport, getFeedbackForThread, getFeedbackForMessages, buildTaskId,
  linkActivityReply, findActivityIdByReply,
} from './db/activities-repo';
export type {
  BeginActivityInput, BeginToolCallInput, TaskListColumn, TaskListResult,
  TaskWithDetails,
  ActivityUsageInput, AgentTokenUsage, UserActivitySummary,
  MessageFeedbackInput, AgentFeedbackReport, FeedbackRating, ThreadFeedback,
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
