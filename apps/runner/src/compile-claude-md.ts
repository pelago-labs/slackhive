/**
 * @fileoverview Agent workspace compiler for the runner service.
 *
 * Writes to the agent's temporary working directory:
 *
 *   1. CLAUDE.md — the agent's main instruction/identity file.
 *      Source: agents.claude_md column (or auto-generated for boss agents).
 *      Learned memories from the DB are INLINED here so the model always
 *      sees them (no skill invocation required). Wiki index is also inlined
 *      when a knowledge wiki exists.
 *
 *   2. .claude/commands/{filename} — Claude Code slash commands.
 *      Source: skills table rows for this agent.
 *      Each skill becomes an invokable /<filename> command.
 *      `/wiki` is injected when `knowledge/wiki/` exists.
 *
 * Directory layout:
 *   /tmp/agents/{slug}/
 *     CLAUDE.md                   ← identity + inlined memories + wiki index
 *     .claude/commands/{filename}.md  ← one file per skill
 *     memory/                     ← per-session agent-written memory files (sync'd to DB by MemoryWatcher)
 *
 * @module runner/compile-claude-md
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Agent, Memory, Skill } from '@slackhive/shared';
import { getDb } from '@slackhive/shared';
import { getAgentSkills, getAgentMemories } from './db';
import { logger } from './logger';

/** Soft cap on inlined memory bytes in CLAUDE.md. Anything above this is truncated with a log. */
const MAX_INLINED_MEMORY_BYTES = 32 * 1024;

/** Base directory for ephemeral agent workspaces. */
const AGENTS_TMP_DIR = process.env.AGENTS_TMP_DIR ?? (
  process.env.DATABASE_TYPE === 'sqlite'
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.slackhive', 'agents')
    : '/tmp/agents'
);


/**
 * Built-in /wiki skill — injected when agent has a knowledge wiki.
 * Searches the compiled wiki for relevant articles.
 */
const WIKI_SKILL = `Search the knowledge wiki for information about: $ARGUMENTS

## How to search
1. Read \`knowledge/wiki/index.md\` — this is the catalog organized by category with one-line summaries for every page
2. Identify relevant pages from the index (check modules/, concepts/, entities/, flows/ sections)
3. Read the specific articles that match the topic
4. Follow cross-references — articles link to related pages via relative paths. Follow "See also" sections for deeper context
5. Check \`knowledge/wiki/log.md\` for recent ingests if the user asks about what sources were processed

## Raw sources
If you need the exact, verbatim text of a user-uploaded file, look in \`knowledge/sources/\` — those are unmodified uploads, not Claude-built. Grep them when an exact quote or figure from the original matters; fall back to the wiki for distilled/indexed reading.

## Tips
- The wiki follows the Karpathy LLM Wiki pattern — pages are richly interlinked
- Entity pages describe data models/classes, module pages describe code components, flow pages trace function call chains
- Every page has source attribution showing where the information came from
- If no relevant articles are found, say so and answer from your general knowledge`;


/**
 * Reject source names that could escape the `knowledge/sources/` directory.
 * Kept narrow — the filename is the source's user-supplied `name`, sanitized to a
 * safe slug here rather than pre-validated at insert time (old rows may exist).
 */
function toSafeFileName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120);
  return (base || 'source') + '.md';
}

/**
 * Materialize every file-type knowledge source to `knowledge/sources/<name>.md`
 * inside the agent workspace. Called on every compile (agent reload) and at the
 * end of `buildKnowledgeWiki`, so the on-disk view matches the DB.
 *
 * Called for side-effect. Failures are logged but don't block compile — a
 * missing sources/ dir shouldn't stop the agent from starting.
 */
export async function writeFileSourcesToDisk(workDir: string, agentId: string): Promise<void> {
  const sourcesDir = path.join(workDir, 'knowledge', 'sources');
  try {
    const r = await getDb().query(
      `SELECT name, content FROM knowledge_sources
       WHERE agent_id = $1 AND type = 'file' AND content IS NOT NULL AND content != ''`,
      [agentId],
    );
    // Wipe first so deleted sources don't linger.
    fs.rmSync(sourcesDir, { recursive: true, force: true });
    if (r.rows.length === 0) return;
    fs.mkdirSync(sourcesDir, { recursive: true });
    for (const row of r.rows) {
      const filename = toSafeFileName(row.name as string);
      fs.writeFileSync(path.join(sourcesDir, filename), (row.content as string) ?? '', 'utf8');
    }
    logger.debug('File sources materialized', {
      agentId, dir: sourcesDir, count: r.rows.length,
    });
  } catch (err) {
    logger.warn('Failed to materialize file sources', { agentId, error: (err as Error).message });
  }
}


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
export async function compileClaudeMd(agent: Agent, overrideClaudeMd?: string, formattingRules?: string): Promise<string> {
  const workDir = getAgentWorkDir(agent.slug);
  const claudeMdPath = getClaudeMdPath(agent.slug);

  fs.mkdirSync(workDir, { recursive: true });

  const [skills, memories] = await Promise.all([
    getAgentSkills(agent.id),
    getAgentMemories(agent.id),
  ]);

  // Identity is rendered from agent.name/persona/description in buildClaudeMd — never a skill row.
  logger.info('Compiling agent workspace', {
    agent: agent.slug,
    skills: skills.length,
    memories: memories.length,
  });

  // -------------------------------------------------------------------------
  // 1. Write CLAUDE.md (identity + inlined memories + knowledge base index)
  // -------------------------------------------------------------------------
  const claudeMdContent = buildClaudeMd(agent, memories, skills, overrideClaudeMd, formattingRules);
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

  // Built-in wiki skill — injected whenever the knowledge wiki dir exists.
  // We do NOT gate on non-empty contents: the wiki may be populated mid-session
  // (compile runs every startup), and the /wiki command is cheap to have present.
  const wikiDir = path.join(workDir, 'knowledge', 'wiki');
  if (fs.existsSync(wikiDir)) {
    fs.writeFileSync(path.join(commandsDir, 'wiki.md'), WIKI_SKILL, 'utf-8');
  }

  // Materialize file-type knowledge sources as verbatim markdown next to the
  // wiki so the agent can Grep/Read the exact original text. Re-derived from
  // DB every compile — deletions, edits, and new uploads all propagate.
  await writeFileSourcesToDisk(workDir, agent.id);

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
      // Wiki skill — propagate to sessions if wiki dir exists
      const sessionWikiDir = path.join(getAgentWorkDir(agent.slug), 'knowledge', 'wiki');
      if (fs.existsSync(sessionWikiDir)) {
        fs.writeFileSync(path.join(sessionCommandsDir, 'wiki.md'), WIKI_SKILL, 'utf-8');
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
 * Builds the inlined `# Learned Memories (active)` section.
 *
 * Memories are written directly into the system prompt so the model always sees
 * them — replaces the old /recall + on-disk materialization path which required
 * the model to proactively invoke a skill. Rules like "when user is U095..., say X"
 * now fire deterministically because both the rule and the sender ID (prepended
 * by the message handler) are in the turn context.
 *
 * Grouped by type for scanability. Memory `name` is used as the heading so the
 * agent can flag contradictions by name (matches the "update/overwrite by name"
 * workflow in the Memory-writing guidance section).
 *
 * If total bytes exceed {@link MAX_INLINED_MEMORY_BYTES}, overflow memories are
 * dropped with a warning — we prefer a truncated-but-bounded prompt over a
 * runaway token cost.
 */
function buildInlinedMemoriesSection(memories: Memory[]): string | null {
  if (memories.length === 0) return null;

  const groups: Record<Memory['type'], Memory[]> = {
    feedback: [], user: [], project: [], reference: [],
  };
  for (const m of memories) {
    if (groups[m.type]) groups[m.type].push(m);
  }

  const typeHeadings: Record<Memory['type'], string> = {
    feedback: 'Feedback (behavioral rules — apply unconditionally)',
    user: 'User (facts about people)',
    project: 'Project (current initiatives)',
    reference: 'Reference (domain knowledge)',
  };

  const parts: string[] = [
    '# Learned Memories (active)',
    '',
    'These are facts and rules you learned in prior conversations. They are active',
    'for EVERY turn — apply any that match the current context without being asked.',
    'If a memory contradicts what the user just said, flag it by name and ask whether to update.',
    '',
  ];

  let bytes = Buffer.byteLength(parts.join('\n'), 'utf-8');
  let dropped = 0;

  for (const type of ['feedback', 'user', 'project', 'reference'] as const) {
    const rows = groups[type];
    if (rows.length === 0) continue;
    const heading = `## ${typeHeadings[type]}`;
    parts.push(heading);
    bytes += Buffer.byteLength(heading + '\n', 'utf-8');

    for (const m of rows) {
      const block = `\n### ${m.name}\n${m.content.trim()}\n`;
      const blockBytes = Buffer.byteLength(block, 'utf-8');
      if (bytes + blockBytes > MAX_INLINED_MEMORY_BYTES) {
        dropped += 1;
        continue;
      }
      parts.push(block);
      bytes += blockBytes;
    }
    parts.push('');
  }

  if (dropped > 0) {
    logger.warn('Memory inlining exceeded cap — some memories dropped', {
      dropped,
      cap: MAX_INLINED_MEMORY_BYTES,
    });
  }

  return parts.join('\n');
}

/**
 * Parses `knowledge/wiki/index.md` to extract article path + one-line summary.
 * Returns null if the index doesn't exist or contains no usable links.
 */
function buildWikiIndexSection(workDir: string): string | null {
  const wikiDir = path.join(workDir, 'knowledge', 'wiki');
  if (!fs.existsSync(wikiDir)) return null;

  let wikiFiles: string[] = [];
  try {
    wikiFiles = (fs.readdirSync(wikiDir, { recursive: true }) as string[])
      .filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md');
  } catch {
    return null;
  }
  if (wikiFiles.length === 0) return null;

  // Parse index.md if present — extract `- [title](path.md) — summary` style lines.
  const indexPath = path.join(wikiDir, 'index.md');
  let inlinedIndex: string | null = null;
  if (fs.existsSync(indexPath)) {
    try {
      const raw = fs.readFileSync(indexPath, 'utf-8');
      // Keep only bulleted lines that reference a .md article — these are the
      // "article entry" lines in the Karpathy wiki pattern. Headings + prose
      // are skipped.
      const articleLines = raw
        .split('\n')
        .filter(line => /^\s*[-*]\s+/.test(line) && /\.md\)/.test(line))
        .map(line => line.trim());
      if (articleLines.length > 0) {
        inlinedIndex = articleLines.join('\n');
      }
    } catch { /* fall through to file listing */ }
  }

  // Fallback: just list filenames if index.md is missing/unusable.
  if (!inlinedIndex) {
    inlinedIndex = wikiFiles.map(f => `- \`${f}\``).join('\n');
  }

  return `# Knowledge Base

You have ${wikiFiles.length} wiki articles in \`knowledge/wiki/\`. Consult them
BEFORE answering questions that might be covered — do NOT say "let me check the
knowledge base" and then refuse. If a question touches anything in the catalog
below, actually read the relevant article(s).

## How to search
- Use \`Grep\` across \`knowledge/wiki/\` for keyword lookups (fastest path).
- Use \`Read\` on a specific article when you know the path.
- \`/wiki <topic>\` is still available for a guided multi-read flow.

## Available articles
${inlinedIndex}

## Verify before recommending
Wiki articles are compiled snapshots. When an article references concrete code
(function names, file paths, schema columns, API endpoints, env vars), treat
it as a HINT — verify against the current source before recommending changes.
If you cannot verify, say so explicitly: "The wiki says X — verify this is still current."`;
}

/**
 * Builds the skills index section — a compact list of available slash commands
 * inlined into CLAUDE.md so the agent knows what skills exist without needing
 * to read the commands directory.
 */
function buildSkillsIndexSection(skills: Skill[], hasWiki: boolean): string | null {
  if (skills.length === 0 && !hasWiki) return null;

  const lines: string[] = [];

  if (hasWiki) {
    lines.push('- `/wiki <topic>` — look up the knowledge base');
  }

  for (const skill of skills) {
    const name = skill.filename.replace(/\.md$/, '');
    lines.push(`- \`/${name}\``);
  }

  return `# Available Skills

Invoke these slash commands when relevant — they load the full procedure on demand:

${lines.join('\n')}`;
}

/**
 * Builds the CLAUDE.md content for an agent.
 * Structure: identity → platform formatting rules → memory system instructions.
 *
 * @param {Agent} agent - The agent.
 * @param {string} [overrideClaudeMd] - Override for identity content (boss registry use).
 * @param {string} [formattingRules] - Platform-specific formatting rules (from adapter).
 * @returns {string} Full CLAUDE.md content.
 */
function buildClaudeMd(
  agent: Agent,
  memories: Memory[],
  skills: Skill[],
  overrideClaudeMd?: string,
  formattingRules?: string,
): string {
  const sections: string[] = [];

  // 1. Identity — always built from agent.name/persona/description. Never a skill row.
  const lines = [`# ${agent.name}`];
  if (agent.persona) lines.push('', agent.persona);
  if (agent.description) lines.push('', agent.description);
  sections.push(lines.join('\n'));

  // 2. System prompt / instructions (claudeMd field — Karpathy-style behavior/guardrails)
  const claudeMd = overrideClaudeMd ?? agent.claudeMd;
  if (claudeMd?.trim()) {
    sections.push(claudeMd.trim());
  }

  // 3. Platform formatting rules (provided by adapter, or fallback to Slack)
  sections.push(formattingRules ?? SLACK_FORMATTING_SECTION);

  // 4. Inlined learned memories — replaces the old /recall skill path so the
  //    model always sees them. See buildInlinedMemoriesSection for rationale.
  const memoriesSection = buildInlinedMemoriesSection(memories);
  if (memoriesSection) sections.push(memoriesSection);

  // 5. Knowledge base index — inlined so the model knows what exists without
  //    a Read round-trip. See buildWikiIndexSection.
  const workDir = getAgentWorkDir(agent.slug);
  const wikiSection = buildWikiIndexSection(workDir);
  if (wikiSection) sections.push(wikiSection);

  // 6. Skills index — compact list of available slash commands so the agent
  //    knows what it can invoke without reading the commands directory.
  const hasWiki = fs.existsSync(path.join(workDir, 'knowledge', 'wiki'));
  const skillsSection = buildSkillsIndexSection(skills, hasWiki);
  if (skillsSection) sections.push(skillsSection);

  // 6. Memory-writing guidance — how the agent SAVES new memories. Reading
  //    existing memories is handled by the inlined section above; this block
  //    only covers the write path (and when to ask before saving).
  sections.push(`# Saving New Memories

When you learn something that will genuinely help in future conversations —
a correction, a preference, a decision, a useful fact — save it as a memory.
Use the Write tool to create \`memory/{type}_{name}.md\`:

\`\`\`
---
name: {short_descriptive_name}
type: {feedback | user | project | reference}
description: {one line summary}
---
{memory content — concise and actionable}
\`\`\`

## When to ask vs save silently
**NEVER save silently** unless the user explicitly said "remember this" / "save this".
- Mistake or correction → "Got it — should I remember this for next time?"
- New useful info (preference, decision, workflow) → "That's useful — want me to remember this?"
- Explicit request → save immediately.

## Memory types
- \`feedback\` — corrections, rules ("don't do X", "always do Y")
- \`user\` — preferences, working style, role, goals
- \`project\` — decisions, constraints, architecture choices
- \`reference\` — facts, patterns, domain knowledge

## What NOT to save
- Trivial or one-off context
- Things derivable from code, git history, or docs
- Vague observations — be specific
- Anything the user told you not to remember

## Updating + contradictions
- Prefer updating over creating duplicates — write to the same filename to overwrite.
- If a memory in the **Learned Memories** section above contradicts what the user
  just said, flag it by name: "I have a memory that says X, but you're saying Y —
  should I update it?" Then overwrite if they confirm.`);

  return sections.join('\n\n---\n\n');
}

