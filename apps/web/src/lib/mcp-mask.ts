/**
 * @fileoverview MCP server config masking utilities.
 *
 * Sensitive values in MCP configs (env vars for stdio, headers for sse/http)
 * must never be returned to the client in plaintext. This module provides
 * masking for API GET responses and merge logic for PATCH requests so that
 * a client sending back "********" placeholders does not overwrite real values.
 *
 * @module web/lib/mcp-mask
 */

import type { McpServer, McpServerConfig } from '@slackhive/shared';

const MASK = '********';

/**
 * Returns a copy of the MCP config with all secret values replaced by MASK.
 * - stdio: masks each value in `config.env`
 * - sse/http: masks each value in `config.headers`
 *
 * @param {McpServerConfig} config - Raw config from DB.
 * @returns {McpServerConfig} Masked config safe for API responses.
 */
export function maskMcpConfig(config: McpServerConfig): McpServerConfig {
  const c = config as unknown as Record<string, unknown>;
  if (c.env && typeof c.env === 'object') {
    const masked: Record<string, string> = {};
    for (const key of Object.keys(c.env as Record<string, string>)) {
      masked[key] = MASK;
    }
    // envRefs and tsSource are not secrets — pass through unchanged
    return { ...c, env: masked } as McpServerConfig;
  }
  if (c.headers && typeof c.headers === 'object') {
    const masked: Record<string, string> = {};
    for (const key of Object.keys(c.headers as Record<string, string>)) {
      masked[key] = MASK;
    }
    return { ...c, headers: masked } as McpServerConfig;
  }
  return config;
}

/**
 * Returns a copy of the MCP server with its config secrets masked.
 *
 * @param {McpServer} server - Full server record from DB.
 * @returns {McpServer} Server safe for API responses.
 */
export function maskMcpServer(server: McpServer): McpServer {
  return { ...server, config: maskMcpConfig(server.config) };
}

/**
 * Merges an incoming (possibly masked) config from a PATCH request with the
 * existing config stored in the DB. Any value equal to MASK is replaced with
 * the corresponding existing value, preserving secrets the client never saw.
 *
 * @param {McpServerConfig} existing - Current config from DB (unmasked).
 * @param {McpServerConfig} incoming - Config from PATCH body (may contain MASK values).
 * @returns {McpServerConfig} Merged config safe to write back to DB.
 */
export function mergeMcpConfig(existing: McpServerConfig, incoming: McpServerConfig): McpServerConfig {
  const e = existing as unknown as Record<string, unknown>;
  const i = incoming as unknown as Record<string, unknown>;

  if (i.env && typeof i.env === 'object' && e.env && typeof e.env === 'object') {
    const merged: Record<string, string> = { ...(e.env as Record<string, string>) };
    for (const [key, val] of Object.entries(i.env as Record<string, string>)) {
      merged[key] = val === MASK ? (merged[key] ?? val) : val;
    }
    // Remove keys not present in incoming (user deleted them)
    for (const key of Object.keys(merged)) {
      if (!(key in (i.env as Record<string, string>))) delete merged[key];
    }
    return { ...i, env: merged } as McpServerConfig;
  }

  if (i.headers && typeof i.headers === 'object' && e.headers && typeof e.headers === 'object') {
    const merged: Record<string, string> = { ...(e.headers as Record<string, string>) };
    for (const [key, val] of Object.entries(i.headers as Record<string, string>)) {
      merged[key] = val === MASK ? (merged[key] ?? val) : val;
    }
    for (const key of Object.keys(merged)) {
      if (!(key in (i.headers as Record<string, string>))) delete merged[key];
    }
    return { ...i, headers: merged } as McpServerConfig;
  }

  return incoming;
}
