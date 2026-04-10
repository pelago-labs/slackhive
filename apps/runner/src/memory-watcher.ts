/**
 * @fileoverview Memory watcher — the primary learning mechanism for agents.
 *
 * Watches the agent's memory directory (`/tmp/agents/{slug}/.claude/memory/`)
 * for file changes made by the Claude Code SDK during conversations. When the
 * SDK writes a new memory file or updates an existing one, this watcher reads
 * the file, parses the frontmatter to extract the memory type and name, and
 * upserts the record into the `memories` database table.
 *
 * This is how agents learn: every memory the SDK writes during a conversation
 * is immediately persisted to Postgres. On the next agent restart, all memories
 * are re-materialized to disk so the agent starts with full accumulated knowledge.
 *
 * Memory file format (frontmatter + markdown body):
 * ```markdown
 * ---
 * name: feedback_avoid_mocking
 * description: Don't mock the database in tests
 * type: feedback
 * ---
 *
 * Memory content here...
 * ```
 *
 * @module runner/memory-watcher
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Agent, Memory } from '@slackhive/shared';
import { upsertMemorySafe } from './db';
import { agentLogger } from './logger';
import { getAgentWorkDir } from './compile-claude-md';

/** Delay in ms after a file change before reading it (debounce). */
const DEBOUNCE_MS = 200;

/**
 * Watches an agent's memory directory for new or updated memory files,
 * persisting changes to the database as they occur.
 *
 * @example
 * const watcher = new MemoryWatcher(agent);
 * watcher.start();
 * // ... agent runs ...
 * watcher.stop();
 */
export class MemoryWatcher {
  private readonly agent: Agent;
  private readonly memoryDir: string;
  private readonly sessionsDir: string;
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly log: ReturnType<typeof agentLogger>;

  constructor(agent: Agent) {
    this.agent = agent;
    const workDir = getAgentWorkDir(agent.slug);
    this.memoryDir = path.join(workDir, 'memory');
    this.sessionsDir = path.join(workDir, 'sessions');
    this.log = agentLogger(agent.slug);
  }

  start(): void {
    if (this.watchers.length > 0) return;

    // Watch both session memory dirs and the root memory dir.
    // The root memory dir is materialized from DB on startup, but agents may also
    // write directly to it (e.g. when cwd resolves to the workdir root).
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.memoryDir, { recursive: true });
    this.watchSessionsRoot();
    this.watchDir(this.memoryDir);

    this.log.info('Memory watcher started', { sessionsDir: this.sessionsDir });
  }

  /** Watch the sessions root for new session directories being created. */
  private watchSessionsRoot(): void {
    const watcher = fs.watch(this.sessionsDir, { persistent: false }, (eventType, filename) => {
      if (!filename) return;
      const sessionDir = path.join(this.sessionsDir, filename);
      const memDir = path.join(sessionDir, 'memory');
      // When a new session dir appears, start watching its memory dir
      if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
        fs.mkdirSync(memDir, { recursive: true });
        this.watchDir(memDir);
      }
    });
    watcher.on('error', (err) => this.log.warn('Sessions root watcher error', { error: err.message }));
    this.watchers.push(watcher);

    // Also watch any existing session memory dirs
    if (fs.existsSync(this.sessionsDir)) {
      for (const entry of fs.readdirSync(this.sessionsDir)) {
        const memDir = path.join(this.sessionsDir, entry, 'memory');
        fs.mkdirSync(memDir, { recursive: true });
        this.watchDir(memDir);
      }
    }
  }

  /** Watch a specific memory directory for .md file changes. */
  private watchDir(memDir: string): void {
    // Avoid duplicate watchers
    const watcher = fs.watch(memDir, { persistent: false }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      const filePath = path.join(memDir, filename);
      const timerKey = filePath;

      const existing = this.debounceTimers.get(timerKey);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(timerKey);
        this.handleMemoryFileChange(filePath).catch((err) => {
          this.log.error('Failed to sync memory file', { filePath, error: err.message });
        });
      }, DEBOUNCE_MS);

      this.debounceTimers.set(timerKey, timer);
    });
    watcher.on('error', (err) => this.log.warn('Memory dir watcher error', { dir: memDir, error: err.message }));
    this.watchers.push(watcher);
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.log.info('Memory watcher stopped');
  }

  private async handleMemoryFileChange(filePath: string): Promise<void> {

    if (!fs.existsSync(filePath)) {
      // File was deleted — we keep the DB record (deletions are explicit via UI)
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseMemoryFile(content);

    if (!parsed) {
      this.log.warn('Could not parse memory file, skipping', { filePath });
      return;
    }

    await upsertMemorySafe(this.agent.id, parsed.type, parsed.name, content);

    this.log.info('Memory synced to DB', {
      filePath,
      name: parsed.name,
      type: parsed.type,
    });
  }
}

// =============================================================================
// Memory file parser
// =============================================================================

/**
 * Parsed result from a memory file's YAML frontmatter.
 */
interface ParsedMemoryFrontmatter {
  name: string;
  type: Memory['type'];
}

/**
 * Parses the YAML frontmatter from a memory file to extract `name` and `type`.
 *
 * Memory files written by the Claude Code SDK follow the format:
 * ```
 * ---
 * name: some_memory_name
 * type: feedback
 * description: optional description
 * ---
 * Content...
 * ```
 *
 * @param {string} content - Full file content including frontmatter.
 * @returns {ParsedMemoryFrontmatter | null} Parsed frontmatter, or null if invalid.
 */
export function parseMemoryFile(content: string): ParsedMemoryFrontmatter | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  const name = extractField(frontmatter, 'name');
  const type = extractField(frontmatter, 'type') as Memory['type'] | null;

  if (!name || !type) return null;

  const validTypes: Memory['type'][] = ['user', 'feedback', 'project', 'reference'];
  if (!validTypes.includes(type)) return null;

  return { name, type };
}

/**
 * Extracts a single YAML field value from a frontmatter string.
 * Only supports simple `key: value` pairs (no nested objects or arrays).
 *
 * @param {string} frontmatter - YAML frontmatter content.
 * @param {string} field - Field name to extract.
 * @returns {string | null} Trimmed field value, or null if not found.
 */
function extractField(frontmatter: string, field: string): string | null {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}
