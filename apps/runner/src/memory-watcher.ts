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
import type { Agent, Memory } from '@slack-agent-team/shared';
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
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly log: ReturnType<typeof agentLogger>;

  /**
   * Creates a new MemoryWatcher for an agent.
   *
   * @param {Agent} agent - The agent whose memory directory to watch.
   */
  constructor(agent: Agent) {
    this.agent = agent;
    this.memoryDir = path.join(getAgentWorkDir(agent.slug), '.claude', 'memory');
    this.log = agentLogger(agent.slug);
  }

  /**
   * Starts watching the memory directory.
   * Creates the directory if it does not exist.
   * Safe to call multiple times (no-op if already watching).
   *
   * @returns {void}
   */
  start(): void {
    if (this.watcher) return;

    // Ensure the memory directory exists before watching
    fs.mkdirSync(this.memoryDir, { recursive: true });

    this.log.info('Memory watcher started', { dir: this.memoryDir });

    this.watcher = fs.watch(this.memoryDir, { persistent: false }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;

      // Debounce: wait for file write to complete before reading
      const existing = this.debounceTimers.get(filename);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(filename);
        this.handleMemoryFileChange(filename).catch((err) => {
          this.log.error('Failed to sync memory file', { filename, error: err.message });
        });
      }, DEBOUNCE_MS);

      this.debounceTimers.set(filename, timer);
    });

    this.watcher.on('error', (err) => {
      this.log.warn('Memory watcher error', { error: err.message });
    });
  }

  /**
   * Stops watching the memory directory and clears all pending timers.
   *
   * @returns {void}
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.log.info('Memory watcher stopped');
  }

  /**
   * Handles a change to a memory file.
   * Reads the file, parses its frontmatter, and upserts to the database.
   *
   * @param {string} filename - The changed filename (basename only).
   * @returns {Promise<void>}
   */
  private async handleMemoryFileChange(filename: string): Promise<void> {
    const filePath = path.join(this.memoryDir, filename);

    if (!fs.existsSync(filePath)) {
      // File was deleted — we keep the DB record (deletions are explicit via UI)
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseMemoryFile(content);

    if (!parsed) {
      this.log.warn('Could not parse memory file, skipping', { filename });
      return;
    }

    await upsertMemorySafe(this.agent.id, parsed.type, parsed.name, content);

    this.log.info('Memory synced to DB', {
      filename,
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
function parseMemoryFile(content: string): ParsedMemoryFrontmatter | null {
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
