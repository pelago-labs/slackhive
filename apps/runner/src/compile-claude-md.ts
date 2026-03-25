/**
 * @fileoverview CLAUDE.md compiler for the runner service.
 *
 * Compiles an agent's skills and memories from the database into a single
 * CLAUDE.md file written to a temporary working directory. This file is
 * passed to the Claude Code SDK as the agent's system prompt via the `cwd`
 * option with `settingSources: ['project']`.
 *
 * Compilation order:
 *   1. Skills, sorted by category (ASC) then sort_order (ASC)
 *   2. Memories section (grouped by type: feedback → user → project → reference)
 *
 * The output directory is `/tmp/agents/{slug}/`. It is recreated on every
 * agent start or reload. The database is always the source of truth.
 *
 * @module runner/compile-claude-md
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Agent, Skill, Memory } from '@slack-agent-team/shared';
import { getAgentSkills, getAgentMemories } from './db';
import { logger } from './logger';

/** Base directory for ephemeral agent workspaces. */
const AGENTS_TMP_DIR = process.env.AGENTS_TMP_DIR ?? '/tmp/agents';

/**
 * Returns the temporary working directory path for an agent.
 *
 * @param {string} slug - Agent slug (e.g., "gilfoyle").
 * @returns {string} Absolute path to the agent's temp workspace.
 */
export function getAgentWorkDir(slug: string): string {
  return path.join(AGENTS_TMP_DIR, slug);
}

/**
 * Returns the path to the CLAUDE.md file for an agent.
 *
 * @param {string} slug - Agent slug.
 * @returns {string} Absolute path to CLAUDE.md.
 */
export function getClaudeMdPath(slug: string): string {
  return path.join(getAgentWorkDir(slug), 'CLAUDE.md');
}

/**
 * Compiles an agent's skills and memories from the database into a CLAUDE.md
 * file in the agent's temporary working directory.
 *
 * This is the core function that enables:
 * - Agent identity and behavior (from skills)
 * - Learned knowledge from past interactions (from memories)
 *
 * @param {Agent} agent - The agent to compile for.
 * @returns {Promise<string>} The path to the temporary working directory
 *   (i.e., the `cwd` to pass to the Claude Code SDK).
 * @throws {Error} If writing to the filesystem fails.
 *
 * @example
 * const cwd = await compileClaudeMd(agent);
 * // Pass cwd to Claude Code SDK options
 */
export async function compileClaudeMd(agent: Agent): Promise<string> {
  const workDir = getAgentWorkDir(agent.slug);
  const claudeMdPath = getClaudeMdPath(agent.slug);

  // Ensure workspace directory exists (recreate on each start)
  fs.mkdirSync(workDir, { recursive: true });

  // Load skills and memories from DB
  const [skills, memories] = await Promise.all([
    getAgentSkills(agent.id),
    getAgentMemories(agent.id),
  ]);

  logger.info('Compiling CLAUDE.md', {
    agent: agent.slug,
    skills: skills.length,
    memories: memories.length,
  });

  const sections: string[] = [];

  // -------------------------------------------------------------------------
  // Section 1: Skills
  // Skills define the agent's identity, knowledge, workflow, and capabilities.
  // They are ordered by category then sort_order — this mirrors the original
  // build-claude-md.ts pattern from nlq-claude-slack-bot.
  // -------------------------------------------------------------------------
  if (skills.length > 0) {
    sections.push(compileSkillsSection(skills));
  } else {
    // Minimal fallback if no skills are defined yet
    sections.push(compileDefaultIdentity(agent));
  }

  // -------------------------------------------------------------------------
  // Section 2: Memories
  // Memories are what the agent has learned from past interactions.
  // They are appended after skills so they can override or refine behavior.
  // Grouped by type for readability: feedback → user → project → reference
  // -------------------------------------------------------------------------
  if (memories.length > 0) {
    sections.push(compileMemoriesSection(memories));
  }

  const claudeMdContent = sections.join('\n\n---\n\n');

  fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf-8');

  logger.debug('CLAUDE.md written', {
    agent: agent.slug,
    path: claudeMdPath,
    bytes: Buffer.byteLength(claudeMdContent, 'utf-8'),
  });

  return workDir;
}

/**
 * Materializes memory files from the database to the agent's temp workspace.
 *
 * Memory files are written to `/tmp/agents/{slug}/.claude/memory/` so the
 * Claude Code SDK can read and update them directly during conversations.
 * The runner watches this directory to detect new or updated memories.
 *
 * @param {Agent} agent - The agent to materialize memories for.
 * @param {Memory[]} memories - Memory entries from the database.
 * @returns {void}
 */
export function materializeMemoryFiles(agent: Agent, memories: Memory[]): void {
  const memoryDir = path.join(getAgentWorkDir(agent.slug), '.claude', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  for (const memory of memories) {
    const filename = `${memory.type}_${sanitizeFilename(memory.name)}.md`;
    const filePath = path.join(memoryDir, filename);
    fs.writeFileSync(filePath, memory.content, 'utf-8');
  }

  logger.debug('Memory files materialized', {
    agent: agent.slug,
    count: memories.length,
    dir: memoryDir,
  });
}

// =============================================================================
// Private helpers
// =============================================================================

/**
 * Compiles all skill files into a concatenated string for CLAUDE.md.
 * Each skill is separated by a newline for readability.
 *
 * @param {Skill[]} skills - Ordered skill records from the database.
 * @returns {string} Compiled skills content.
 */
function compileSkillsSection(skills: Skill[]): string {
  return skills.map((s) => s.content.trim()).join('\n\n');
}

/**
 * Generates a minimal default identity section when no skills are defined.
 *
 * @param {Agent} agent - The agent.
 * @returns {string} Default identity markdown.
 */
function compileDefaultIdentity(agent: Agent): string {
  const lines = [`# ${agent.name}`];
  if (agent.persona) lines.push('', agent.persona);
  if (agent.description) lines.push('', agent.description);
  return lines.join('\n');
}

/**
 * Compiles memory entries into a structured CLAUDE.md section.
 * Memories are grouped by type and formatted to give the agent clear
 * context about what it has learned from past interactions.
 *
 * @param {Memory[]} memories - Memory entries from the database.
 * @returns {string} Compiled memories section.
 */
function compileMemoriesSection(memories: Memory[]): string {
  const typeOrder: Memory['type'][] = ['feedback', 'user', 'project', 'reference'];
  const grouped = new Map<Memory['type'], Memory[]>();

  for (const memory of memories) {
    if (!grouped.has(memory.type)) grouped.set(memory.type, []);
    grouped.get(memory.type)!.push(memory);
  }

  const lines: string[] = [
    '# Learned Memory',
    '',
    '> The following was learned from past interactions. Apply this knowledge in all responses.',
  ];

  for (const type of typeOrder) {
    const entries = grouped.get(type);
    if (!entries || entries.length === 0) continue;

    lines.push('', `## ${capitalize(type)} Memory`);
    for (const entry of entries) {
      lines.push('', `### ${entry.name}`, '', entry.content.trim());
    }
  }

  return lines.join('\n');
}

/**
 * Sanitizes a string for use as a filename.
 * Replaces non-alphanumeric characters with underscores and lowercases.
 *
 * @param {string} name - Raw name string.
 * @returns {string} Filesystem-safe filename fragment.
 */
function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Capitalizes the first letter of a string.
 *
 * @param {string} s - Input string.
 * @returns {string} String with first letter capitalized.
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
