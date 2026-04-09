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
import type { Agent, Skill } from '@slackhive/shared';
import { getAgentSkills } from './db';
import { logger } from './logger';

/** Base directory for ephemeral agent workspaces. */
const AGENTS_TMP_DIR = process.env.AGENTS_TMP_DIR ?? '/tmp/agents';

/**
 * Memory system instructions injected into every agent's CLAUDE.md.
 * Tells the agent to persist learned facts to .claude/memory/ in its cwd.
 */
/**
 * Slack formatting rules injected into every agent's CLAUDE.md.
 * Built-in at the framework level — not visible in the Skills tab.
 */
const SLACK_FORMATTING_SECTION = `# Slack Formatting

You are responding in Slack. Follow these rules for every message:

**Text formatting:**
- Bold: \`*bold*\` — NOT \`**bold**\`
- Italic: \`_italic_\` — NOT \`*italic*\`
- Section headers: \`*Header Text*\` on its own line — NOT \`#\`, \`##\`, \`###\`
- Inline code: \`` + '`' + `code\`` + '`' + `
- Code blocks: triple backticks with language hint (\`\`\`sql ... \`\`\`)
- Lists: \`- item\` or \`1. item\`
- Links: \`<url|text>\`
- Horizontal rules: just a blank line — NOT \`---\` or \`***\`
- Blockquotes: use plain text or \`_italic_\` — NOT \`>\`

**Tables — use standard Markdown pipe format:**
- Every row MUST start and end with \`|\`
- Always include a separator row: \`|---|---|---|\`
- Do NOT wrap tables in code blocks

Good:
\`\`\`
| Name | Count |
|---|---|
| Alpha | 42 |
\`\`\`

**Never use:** \`## headings\`, \`**double asterisks**\`, \`> blockquotes\`, \`---\` rules`;

const MEMORY_SYSTEM_SECTION = `# Memory System

You have a persistent memory system. Use the built-in \`memory\` MCP tools to recall relevant context from past conversations:

- \`mcp__memory__list_memories\` — see what you know (names + preview), optionally filtered by type
- \`mcp__memory__search_memories(query)\` — find memories by keyword
- \`mcp__memory__get_memory(name)\` — read the full content of a specific memory

**When to recall:** At the start of a conversation, search for memories relevant to the user or topic. When a user references something you may have learned before, look it up.

**Do not write memories yourself** — the system automatically reflects on the conversation after it ends and saves anything worth remembering.`;


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

  const skills = await getAgentSkills(agent.id);

  logger.info('Compiling agent workspace', {
    agent: agent.slug,
    skills: skills.length,
  });

  // -------------------------------------------------------------------------
  // 1. Write CLAUDE.md (identity + memory system instructions)
  // -------------------------------------------------------------------------
  const claudeMdContent = buildClaudeMd(agent, overrideClaudeMd);
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
      fs.writeFileSync(path.join(sessionDir, 'CLAUDE.md'), claudeMdContent, 'utf8');

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


// =============================================================================
// Private helpers
// =============================================================================

/**
 * Builds the CLAUDE.md content for an agent.
 * Structure: identity → Slack formatting rules → memory system instructions.
 *
 * @param {Agent} agent - The agent.
 * @param {string} [overrideClaudeMd] - Override for identity content (boss registry use).
 * @returns {string} Full CLAUDE.md content.
 */
function buildClaudeMd(agent: Agent, overrideClaudeMd?: string): string {
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

  // Slack formatting rules (framework-level, not a skill)
  sections.push(SLACK_FORMATTING_SECTION);

  // Memory system instructions (memories are loaded on-demand via MCP tools)
  sections.push(MEMORY_SYSTEM_SECTION);

  return sections.join('\n\n---\n\n');
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

