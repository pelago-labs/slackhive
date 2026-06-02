/**
 * @fileoverview Agent backend registry + factory. The single place that maps a
 * backend id (from the global `agentBackend` setting) to a concrete
 * `AgentBackend` implementation. Adding a backend = a new file here + one case,
 * exactly like registering a new platform adapter in `adapters/`.
 *
 * @module runner/backends
 */

import type { Agent, McpServer, Permission, AgentBackend } from '@slackhive/shared';
import { ClaudeBackend } from './claude-backend';
import { CodexBackend } from './codex-backend';

export { ClaudeBackend } from './claude-backend';
export { CodexBackend } from './codex-backend';

/**
 * Construct the agent backend for `backendId`. Falls back to Claude for unknown
 * ids so a bad/empty setting never takes the hive down.
 */
export function createAgentBackend(
  backendId: string,
  agent: Agent,
  mcpServers: McpServer[],
  permissions: Permission | null,
  workDir: string,
  envVarValues: Record<string, string> = {},
): AgentBackend {
  switch (backendId) {
    case 'codex':
      return new CodexBackend(agent, mcpServers, permissions, workDir, envVarValues);
    case 'claude':
    default:
      return new ClaudeBackend(agent, mcpServers, permissions, workDir, envVarValues);
  }
}
