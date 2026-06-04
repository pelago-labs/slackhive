/**
 * @fileoverview Extract structured references from an agent's raw
 * `claudeMd` markdown string.
 *
 * Several Tier 1 checks need to compare references found *inside*
 * the markdown — MCP tool calls, skill paths, wiki links, Step 0
 * trigger patterns — against what the agent has declared elsewhere
 * (linked MCP servers, skill rows, wiki folders). This module pulls
 * those references out.
 *
 * Filesystem-free — takes the raw string directly from `agent.claudeMd`.
 *
 * @module web/lib/evals/parse-claude-md
 */

import type { ParsedClaudeMd } from './types';

/** Parse an agent's `claudeMd` markdown into its structured references. */
export function parseClaudeMd(raw: string): ParsedClaudeMd {
  return {
    raw,
    mcpReferences: extractMcpRefs(raw),
    skillReferences: extractMarkdownLinkPaths(raw, 'skills'),
    wikiReferences: extractMarkdownLinkPaths(raw, 'wiki'),
  };
}

function extractMcpRefs(raw: string): string[] {
  const matches = [...raw.matchAll(/\bmcp__[a-z][a-z0-9_-]*__[a-z_][a-z0-9_-]*\b/g)].map(
    (m) => m[0],
  );
  return Array.from(new Set(matches));
}

function extractMarkdownLinkPaths(raw: string, dir: 'skills' | 'wiki'): string[] {
  const pattern = new RegExp(`\\[[^\\]]*\\]\\((${dir}\\/[^)\\s]+\\.md)\\)`, 'g');
  const matches = [...raw.matchAll(pattern)].map((m) => m[1]);
  return Array.from(new Set(matches));
}
