/**
 * @fileoverview Agent workspace compiler for the runner service.
 *
 * Writes two things to the agent's temporary working directory:
 *
 *   1. CLAUDE.md — the agent's main instruction/identity file.
 *      Source: agents.claude_md column (or auto-generated for boss agents).
 *      Memories are appended at the end.
 *
 *   2. .claude/commands/{filename} — Claude Code slash commands.
 *      Source: skills table rows for this agent.
 *      Each skill becomes an invokable /<filename> command.
 *
 * Directory layout:
 *   /tmp/agents/{slug}/
 *     CLAUDE.md                   ← identity + memories
 *     .claude/
 *       commands/
 *         {filename}.md           ← one file per skill
 *       memory/
 *         {type}_{name}.md        ← materialized memory files
 *
 * @module runner/compile-claude-md
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Agent, Skill, Memory } from '@slackhive/shared';
import { getAgentSkills, getAgentMemories } from './db';
import { logger } from './logger';

/** Base directory for ephemeral agent workspaces. */
const AGENTS_TMP_DIR = process.env.AGENTS_TMP_DIR ?? '/tmp/agents';

/**
 * Memory system instructions injected into every agent's CLAUDE.md.
 * Tells the agent to persist learned facts to .claude/memory/ in its cwd.
 */
const MEMORY_SYSTEM_SECTION = `# Memory System

You have a persistent memory system. **At the end of every conversation, proactively save anything useful you learned** — this is how you get smarter over time. Memories persist across all future conversations with every user.

## How to save a memory

Use the Write tool to create a file at \`.claude/memory/{name}.md\`:

\`\`\`markdown
---
name: short_snake_case_name
description: one-line description of what this memory contains
type: user|feedback|project|reference
---

Memory content here...
\`\`\`

**Types:**
- \`user\` — who the user is, their role, team, expertise level, preferences
- \`feedback\` — how the user wants you to behave; corrections; things to avoid or repeat
- \`project\` — ongoing work, context, goals, decisions, important deadlines
- \`reference\` — where to find things: tables, dashboards, channels, docs, repos

## Save proactively — do not wait to be asked

Save a memory whenever you learn:
- Who a user is or what their role/team is
- A user preference or working style ("prefers concise answers", "uses BigQuery not Redshift")
- A correction the user gave you
- A recurring task or project they mentioned
- Where important data/resources live (table names, Slack channels, dashboards, repos)
- A domain-specific fact useful for future queries (schema details, naming conventions, etc.)

**Default to saving.** A slightly over-captured memory is better than a missed one. Do not save the response itself or ephemeral one-off details.

## MEMORY.md index

After writing a memory file, also update \`.claude/memory/MEMORY.md\` with a one-line entry:
\`- [Name](filename.md) — one-line hook\`

## Updating existing memories

If a memory already exists and new info supersedes it, overwrite the file with updated content rather than creating a duplicate.`;


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
 * Compiles the agent workspace: writes CLAUDE.md and skill command files.
 *
 * - CLAUDE.md = agent.claudeMd (identity/instructions) + memory system + memories
 * - .claude/commands/{filename}.md = one file per skill (Claude Code slash commands)
 *
 * For boss agents, CLAUDE.md is auto-generated from the team registry instead of
 * agent.claudeMd (the boss-registry.ts module sets this before calling compileClaudeMd).
 *
 * @param {Agent} agent - The agent to compile for.
 * @param {string} [overrideClaudeMd] - Optional override for CLAUDE.md content (used by boss registry).
 * @returns {Promise<string>} The path to the agent's working directory (pass as cwd to SDK).
 * @throws {Error} If writing to the filesystem fails.
 */
export async function compileClaudeMd(agent: Agent, overrideClaudeMd?: string): Promise<string> {
  const workDir = getAgentWorkDir(agent.slug);
  const claudeMdPath = getClaudeMdPath(agent.slug);

  fs.mkdirSync(workDir, { recursive: true });

  const [skills, memories] = await Promise.all([
    getAgentSkills(agent.id),
    getAgentMemories(agent.id),
  ]);

  logger.info('Compiling agent workspace', {
    agent: agent.slug,
    skills: skills.length,
    memories: memories.length,
  });

  // -------------------------------------------------------------------------
  // 1. Write CLAUDE.md (identity + memory system + memories)
  // -------------------------------------------------------------------------
  const claudeMdContent = buildClaudeMd(agent, memories, overrideClaudeMd);
  fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf-8');

  logger.debug('CLAUDE.md written', {
    agent: agent.slug,
    path: claudeMdPath,
    bytes: Buffer.byteLength(claudeMdContent, 'utf-8'),
  });

  // -------------------------------------------------------------------------
  // 2. Write skills as .claude/commands/{filename}.md
  // -------------------------------------------------------------------------
  const commandsDir = path.join(workDir, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });

  // Remove old command files before rewriting (handles deleted skills)
  for (const existing of fs.readdirSync(commandsDir)) {
    fs.rmSync(path.join(commandsDir, existing), { force: true });
  }

  for (const skill of skills) {
    const filename = skill.filename.endsWith('.md') ? skill.filename : `${skill.filename}.md`;
    fs.writeFileSync(path.join(commandsDir, filename), skill.content, 'utf-8');
  }

  logger.debug('Skill commands written', {
    agent: agent.slug,
    commands: skills.map(s => s.filename),
    dir: commandsDir,
  });

  // -------------------------------------------------------------------------
  // 3. Propagate updates to all existing per-session directories
  // -------------------------------------------------------------------------
  const sessionsDir = path.join(workDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const entry of fs.readdirSync(sessionsDir)) {
      const sessionDir = path.join(sessionsDir, entry);
      if (!fs.statSync(sessionDir).isDirectory()) continue;

      // Update CLAUDE.md
      fs.writeFileSync(path.join(sessionDir, 'CLAUDE.md'), claudeMdContent, 'utf-8');

      // Update .claude/commands/
      const sessionCommandsDir = path.join(sessionDir, '.claude', 'commands');
      fs.mkdirSync(sessionCommandsDir, { recursive: true });
      for (const existing of fs.readdirSync(sessionCommandsDir)) {
        fs.rmSync(path.join(sessionCommandsDir, existing), { force: true });
      }
      for (const skill of skills) {
        const filename = skill.filename.endsWith('.md') ? skill.filename : `${skill.filename}.md`;
        fs.writeFileSync(path.join(sessionCommandsDir, filename), skill.content, 'utf-8');
      }
    }
  }

  return workDir;
}

/**
 * Materializes memory files from the database to the agent's temp workspace.
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
 * Builds the CLAUDE.md content for an agent.
 * Structure: identity → memory system instructions → learned memories.
 *
 * @param {Agent} agent - The agent.
 * @param {Memory[]} memories - Learned memories to append.
 * @param {string} [overrideClaudeMd] - Override for identity content (boss registry use).
 * @returns {string} Full CLAUDE.md content.
 */
function buildClaudeMd(agent: Agent, memories: Memory[], overrideClaudeMd?: string): string {
  const sections: string[] = [];

  // Identity / instructions
  const identity = overrideClaudeMd ?? agent.claudeMd;
  if (identity.trim()) {
    sections.push(identity.trim());
  } else {
    const lines = [`# ${agent.name}`];
    if (agent.persona) lines.push('', agent.persona);
    if (agent.description) lines.push('', agent.description);
    sections.push(lines.join('\n'));
  }

  // Memory system instructions
  sections.push(MEMORY_SYSTEM_SECTION);

  // Learned memories
  if (memories.length > 0) {
    sections.push(compileMemoriesSection(memories));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Compiles memory entries into a structured section for CLAUDE.md.
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
