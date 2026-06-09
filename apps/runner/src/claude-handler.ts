/**
 * @fileoverview Back-compat shim. The Claude runtime moved to
 * `backends/claude-backend.ts` (now `ClaudeBackend implements AgentBackend`)
 * when the agent backend was made pluggable. This re-exports it under the old
 * `ClaudeHandler` name plus the helper functions, so existing imports and tests
 * keep working. Prefer importing from `./backends/claude-backend` in new code.
 *
 * @module runner/claude-handler
 */

export * from './backends/claude-backend';
export { ClaudeBackend as ClaudeHandler } from './backends/claude-backend';
