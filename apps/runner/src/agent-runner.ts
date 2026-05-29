/**
 * @fileoverview Agent runner — manages the lifecycle of all Slack bot instances.
 *
 * The AgentRunner is the top-level orchestrator for the runner service.
 * On startup it loads all active agents from the database, starts a Slack
 * Bolt App for each one, and listens on Redis for reload signals from the
 * web UI.
 *
 * Each agent gets:
 * - Its own Bolt App instance (separate Slack socket connection)
 * - Its own ClaudeHandler (session manager, MCP wiring, tool permissions)
 * - Its own MemoryWatcher (syncs learned memories to the database)
 * - A compiled CLAUDE.md in /tmp/agents/{slug}/ (skills + memories)
 *
 * Hot reload flow:
 * 1. User edits skills/MCPs/permissions in the web UI
 * 2. Web API publishes `{ type: 'reload', agentId }` to Redis channel
 * 3. AgentRunner receives the event, stops the agent, recompiles, restarts
 *
 * @module runner/agent-runner
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { Agent, PlatformAdapter, ThreadMessage } from '@slackhive/shared';
import { type AgentEvent, getEventBus, type EventBus, sweepStaleActivities } from '@slackhive/shared';
import { SlackAdapter } from './adapters/slack-adapter';
import { TestAdapter } from './adapters/test-adapter';
import { MessageHandler } from './message-handler';
import { JobScheduler } from './job-scheduler';
import { markShuttingDown } from './shutdown-signal';
import {
  getAllAgents,
  getAgentById,
  getAgentMcpServers,
  getAgentPermissions,
  getAgentRestrictions,
  getAgentMemories,
  getAgentSkills,
  getAllEnvVarValues,
  updateAgentStatus,
  heartbeatAgents,
  setResult,
  getPlatformIntegration,
  updateWikiSourceStatus,
  getSkillById,
  updateSkillDescription,
  getSkillsMissingDescription,
} from './db';
import { summarizeSkill } from './summarize-skill';
import { compileClaudeMd, getAgentWorkDir } from './compile-claude-md';
import { ClaudeHandler } from './claude-handler';
import { MemoryWatcher } from './memory-watcher';
import { logger } from './logger';
import { dispatchCacheEvent } from './access-cache';

/**
 * Represents a fully initialized running agent.
 * All resources owned by a running agent are held here for cleanup.
 */

/**
 * Files-changed summary between two commits on a wiki source repo. Returned
 * by `readRepoContent` when an incremental diff was successfully computed
 * against `lastSha`. Empty arrays mean no files of that kind changed.
 */
export interface RepoDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

/**
 * Parse the output of `git diff --name-status -M base..HEAD`. Tab-separated.
 * Status codes: A=added, M=modified, D=deleted, R<score>=rename old→new,
 * C<score>=copy (treated as add), T=type change (treated as modified).
 */
export function parseDiffNameStatus(out: string): RepoDiff {
  const diff: RepoDiff = { added: [], modified: [], deleted: [], renamed: [] };
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (status === 'A') diff.added.push(parts[1]);
    else if (status === 'M') diff.modified.push(parts[1]);
    else if (status === 'D') diff.deleted.push(parts[1]);
    else if (status === 'T') diff.modified.push(parts[1]);
    else if (status.startsWith('R') && parts.length >= 3) diff.renamed.push({ from: parts[1], to: parts[2] });
    else if (status.startsWith('C') && parts.length >= 3) diff.added.push(parts[2]);
  }
  return diff;
}

/**
 * Build a diff-focused content block for Claude on incremental wiki re-syncs.
 * Always include a small README excerpt for orientation, then sections for
 * added/modified/renamed file bodies and bare path lists for deleted files.
 *
 * Pure function — read/fileBlock/budgetSection are passed in by the caller
 * (readRepoContent) so the shared snapshot-mode budget bookkeeping stays
 * consistent. Exported so unit tests can exercise the section composition
 * directly with stubbed file readers, without spinning up an AgentRunner.
 */
export function buildDiffFocusedRepoContent(
  tmpDir: string,
  diff: RepoDiff,
  src: Record<string, unknown>,
  lastSha: string,
  currentSha: string,
  branch: string,
  read: (p: string, max?: number) => string,
  fileBlock: (relPath: string, content: string) => string,
  budgetSection: (title: string, content: string) => string,
): string {
  const path = require('path') as typeof import('path');
  const sections: string[] = [];
  sections.push(
    `# Repository: ${src.name as string} (incremental diff)\n` +
    `Branch: ${branch} | URL: ${src.repo_url as string}\n` +
    `Range: ${lastSha.slice(0, 7)}..${currentSha.slice(0, 7)}\n` +
    `Files changed — added: ${diff.added.length}, modified: ${diff.modified.length}, ` +
    `deleted: ${diff.deleted.length}, renamed: ${diff.renamed.length}`
  );

  // Always provide README context — even small diffs are easier for Claude
  // to interpret with a one-paragraph reminder of what this repo is about.
  let readme = '';
  for (const f of ['README.md', 'readme.md', 'README.rst', 'README']) {
    const c = read(path.join(tmpDir, f), 4_000);
    if (c) { readme = c; break; }
  }
  if (readme) sections.push(budgetSection('README (for context)', readme));

  // Deleted files — paths only. Claude uses these to mark articles that
  // referenced them for cleanup. No need to ship the (now-gone) content.
  if (diff.deleted.length) {
    sections.push(budgetSection(
      'Deleted files (mark articles that referenced these for removal)',
      diff.deleted.map(p => `- ${p}`).join('\n'),
    ));
  }

  // Renamed files — show the from→to mapping so Claude can update path
  // references in existing articles, and include the new file content.
  if (diff.renamed.length) {
    sections.push(budgetSection(
      'Renamed files (update article references from old → new path)',
      diff.renamed.map(r => `- ${r.from} → ${r.to}`).join('\n'),
    ));
  }

  // Added files — full content.
  if (diff.added.length) {
    let added = '';
    for (const p of diff.added) {
      const c = read(path.join(tmpDir, p));
      if (c) added += fileBlock(p, c);
    }
    if (added) sections.push(budgetSection('Added files (NEW)', added));
  }

  // Modified files — full content. Claude already has the existing wiki
  // article catalog from the prompt's "Existing wiki" section so it can
  // update articles in place rather than recreate.
  if (diff.modified.length) {
    let modified = '';
    for (const p of diff.modified) {
      const c = read(path.join(tmpDir, p));
      if (c) modified += fileBlock(p, c);
    }
    if (modified) sections.push(budgetSection('Modified files (UPDATED)', modified));
  }

  // Renamed file new content.
  if (diff.renamed.length) {
    let renamed = '';
    for (const r of diff.renamed) {
      const c = read(path.join(tmpDir, r.to));
      if (c) renamed += fileBlock(`${r.to} (renamed from ${r.from})`, c);
    }
    if (renamed) sections.push(budgetSection('Renamed files (new content)', renamed));
  }

  return sections.filter(s => s.trim()).join('\n');
}

/**
 * Wiki source manifest entry. Mirrors the in-file shape used by
 * buildWikiFolderSources's manifest.json; promoted to a named type for
 * the extracted helpers to share.
 */
export interface SourceManifest {
  [sourceName: string]: { created: string[]; updated: string[] };
}

/**
 * Process the `removed` field from a Claude wiki response. Validates each
 * path stays inside `wikiDir`, unlinks the article, and trims the entry from
 * the source manifest so subsequent syncs see an honest catalog. Skipped
 * silently for non-string entries.
 *
 * Pure side-effects on the filesystem and the (mutable) manifest argument —
 * extracted so unit tests can exercise traversal protection + manifest
 * cleanup without spinning up the full wiki build flow.
 */
export function processRemovedArticles(
  wikiDir: string,
  sourceSlug: string,
  sourceName: string,
  removedRaw: unknown[],
  manifest: SourceManifest,
  log: { info: (m: string, ctx?: object) => void; warn: (m: string, ctx?: object) => void },
): void {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  // Confine deletes to THIS source's subdirectory. Without the slug-scoped
  // prefix, a path like '../other-source/secret.md' would (after the
  // sourceSlug-prefix nudge below) resolve to a sibling source's article
  // and delete it. Only protecting against escaping wikiDir entirely is
  // insufficient — that lets one source's response trash another's.
  const sourceRoot = path.join(wikiDir, sourceSlug) + path.sep;
  for (const removedPathRaw of removedRaw) {
    if (typeof removedPathRaw !== 'string') continue;
    const removedPath = removedPathRaw.startsWith(`${sourceSlug}/`) ? removedPathRaw : `${sourceSlug}/${removedPathRaw}`;
    const p = path.resolve(wikiDir, removedPath);
    if (!p.startsWith(sourceRoot)) {
      log.warn('[wiki] Skipping remove path outside source slug', { path: removedPath, sourceSlug });
      continue;
    }
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        log.info('[wiki] Removed article (source file deleted)', { path: removedPath });
        if (manifest[sourceName]) {
          manifest[sourceName].created = (manifest[sourceName].created ?? []).filter(p => p !== removedPath);
          manifest[sourceName].updated = (manifest[sourceName].updated ?? []).filter(p => p !== removedPath);
        }
      }
    } catch (err) {
      log.warn('[wiki] Failed to remove article', { path: removedPath, error: (err as Error).message });
    }
  }
}

interface RunningAgent {
  agent: Agent;
  adapter: PlatformAdapter;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
  memoryWatcher: MemoryWatcher;
}

/**
 * One agent participating in a multi-agent test session. Each participant
 * has its own adapter + ClaudeHandler + MessageHandler, but they share the
 * session's `history` so every agent sees the full multi-bot thread.
 *
 * The participant's `channelId` / `threadId` are shared across the whole
 * session (the synthetic "test thread") so `getThreadMessages` returns the
 * same data for everyone.
 */
export interface AgentParticipant {
  agent: Agent;
  adapter: TestAdapter;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
  workDir: string;
}

/**
 * Ephemeral team test session — one per browser tab running test mode.
 *
 * Rooted at the agent the user opened Test on. When a participant emits a
 * `<@U...>` mention in its output, the orchestrator lazy-spins a participant
 * for the mentioned agent (if not already in the session) and injects the
 * sender's message as if Slack had delivered an `app_mention`. The shared
 * `history` is what makes thread context work across the team.
 *
 * Deliberately NOT going through {@link AgentRunner.startAgent}:
 *   - no platform integration (the whole point of test mode)
 *   - no MemoryWatcher (memory writes stay in a throwaway workDir)
 *   - mcpServers = [] avoids port-range conflicts with a real running agent
 *   - restrictions = null so the synthetic channel isn't blocked
 */
export interface TeamTestSession {
  rootAgentId: string;
  sessionId: string;
  participants: Map<string, AgentParticipant>;
  /** Shared ref — every participant's adapter.history points at this. */
  history: ThreadMessage[];
  /** Parent dir of every participant's workDir — removed on teardown. */
  workDirRoot: string;
  lastUsedAt: number;
}

/** Sessions idle longer than this are reaped on the next tick. */
const TEST_SESSION_IDLE_MS = 30 * 60 * 1_000;

/**
 * Build the root directory for a team test session. One dir per browser tab,
 * nested under the session's root agent's workDir:
 *   `{rootAgentWorkDir}/test-sessions/{sessionId}/`
 * Each participant gets its own subdir under this root (see
 * {@link buildParticipantWorkDir}).
 */
function buildSessionRootDir(rootAgentWorkDir: string, sessionId: string, rootSlug: string): string {
  const root = path.join(rootAgentWorkDir, 'test-sessions', sessionId);
  fs.mkdirSync(root, { recursive: true });
  // Marker file so on-disk inspection distinguishes test sessions.
  fs.writeFileSync(path.join(root, '.test-session'), rootSlug, 'utf-8');
  return root;
}

/**
 * Create an isolated copy of a participant's compiled workDir inside a team
 * test session. Keeps CLAUDE.md + .claude/commands/ + (symlinked) knowledge
 * so the test agent has the same skills + knowledge as the real one, but
 * memory files it writes during the session land in `{participantDir}/sessions/*`
 * and are discarded on teardown — never touching the live agent's dir.
 *
 * Participants are namespaced by slug so the boss and each specialist have
 * independent SDK session / memory dirs inside one test session.
 */
function buildParticipantWorkDir(
  sessionRoot: string,
  agentSlug: string,
  agentWorkDir: string,
): string {
  const participantDir = path.join(sessionRoot, agentSlug);
  fs.mkdirSync(participantDir, { recursive: true });

  const claudeMdSrc = path.join(agentWorkDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(participantDir, 'CLAUDE.md'));
  }

  const commandsSrc = path.join(agentWorkDir, '.claude', 'commands');
  if (fs.existsSync(commandsSrc)) {
    const commandsDst = path.join(participantDir, '.claude', 'commands');
    fs.mkdirSync(commandsDst, { recursive: true });
    for (const f of fs.readdirSync(commandsSrc)) {
      fs.copyFileSync(path.join(commandsSrc, f), path.join(commandsDst, f));
    }
  }

  // Symlink the wiki if present — avoids duplicating a potentially-large
  // knowledge base into every participant.
  const wikiSrc = path.join(agentWorkDir, 'knowledge', 'wiki');
  const wikiDst = path.join(participantDir, 'knowledge', 'wiki');
  if (fs.existsSync(wikiSrc) && !fs.existsSync(wikiDst)) {
    fs.mkdirSync(path.dirname(wikiDst), { recursive: true });
    try { fs.symlinkSync(wikiSrc, wikiDst); } catch { /* fs without symlink — skip */ }
  }

  // Symlink raw file sources too — same reasoning as wiki above.
  const sourcesSrc = path.join(agentWorkDir, 'knowledge', 'sources');
  const sourcesDst = path.join(participantDir, 'knowledge', 'sources');
  if (fs.existsSync(sourcesSrc) && !fs.existsSync(sourcesDst)) {
    fs.mkdirSync(path.dirname(sourcesDst), { recursive: true });
    try { fs.symlinkSync(sourcesSrc, sourcesDst); } catch { /* fs without symlink — skip */ }
  }

  return participantDir;
}

/**
 * Manages the lifecycle of all Claude Code Slack bot instances.
 *
 * @example
 * const runner = new AgentRunner();
 * await runner.start();
 * // Ctrl+C triggers graceful shutdown
 */
export class AgentRunner {
  /** Map of agent ID → running agent resources. */
  private runningAgents: Map<string, RunningAgent> = new Map();

  /** Map of `${rootAgentId}:${sessionId}` → ephemeral team test session. */
  private testSessions: Map<string, TeamTestSession> = new Map();

  /** Scheduled job executor. */
  private jobScheduler: JobScheduler;

  /** Event bus for hot-reload events (Redis or in-memory). */
  private eventBus: EventBus | null = null;

  /** Internal HTTP server for receiving events from the web process. */
  private internalServer: import('http').Server | null = null;

  /**
   * Per-process UUID identifying this runner. Written to `agents.runner_id`
   * on every status transition so a stray runner's writes are distinguishable
   * from the owning runner's writes.
   */
  private readonly runnerId: string = randomUUID();

  /** Interval handle for the heartbeat loop — cleared on stop(). */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** Interval handle for the periodic stale-activity sweep — cleared on stop(). */
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.jobScheduler = new JobScheduler((agentId: string) => this.getRunningAgent(agentId));
  }

  /**
   * Returns any running agent by ID, or undefined if not running.
   */
  getRunningAgent(agentId: string): { adapter: PlatformAdapter; claudeHandler: import('./claude-handler').ClaudeHandler } | undefined {
    const ra = this.runningAgents.get(agentId);
    return ra ? { adapter: ra.adapter, claudeHandler: ra.claudeHandler } : undefined;
  }

  /**
   * Re-runs an activity by reconstructing its original Slack-side message and
   * handing it to the live MessageHandler — the same path a fresh @mention
   * would take. Used to recover from interrupted activities (e.g. an agent
   * that was wedged and reaped, or a turn lost to a runner restart).
   *
   * The Claude session is keyed by (user, channel, thread) and persisted, so
   * the agent resumes with the full prior context. A new activity row is
   * created for the retry; the old errored row is left in place for history.
   */
  async replayActivity(activityId: string): Promise<{ ok: boolean; error?: string }> {
    if (!activityId) return { ok: false, error: 'activityId required' };

    const { getDb } = await import('@slackhive/shared');
    const { rows } = await getDb().query(
      `SELECT a.message_ref, a.message_preview, a.initiator_user_id, a.platform,
              a.agent_id, t.channel_id, t.thread_ts
         FROM activities a LEFT JOIN tasks t ON t.id = a.task_id
        WHERE a.id = $1`,
      [activityId],
    );
    if (rows.length === 0) return { ok: false, error: 'activity not found' };
    const r = rows[0] as Record<string, string | null>;

    if (!r.initiator_user_id || !r.channel_id || !r.message_preview) {
      return { ok: false, error: 'activity missing replay fields (channel/user/text)' };
    }

    const running = this.runningAgents.get(r.agent_id as string);
    if (!running) return { ok: false, error: 'agent not running' };

    const platform = (r.platform ?? 'slack') as string;
    const msg = {
      id: r.message_ref ?? `replay-${activityId}`,
      platform,
      userId: r.initiator_user_id,
      channelId: r.channel_id,
      threadId: r.thread_ts ?? undefined,
      text: r.message_preview,
      // Slack DM channels are prefixed 'D'; everything else is a channel/group.
      isDM: platform === 'slack' && r.channel_id.startsWith('D'),
      raw: { replay: true, originalActivityId: activityId },
    };

    logger.info('Replaying activity', { activityId, agent: running.agent.slug, channelId: msg.channelId, threadId: msg.threadId });
    running.messageHandler.handleMessage(msg as any).catch((err) =>
      logger.error('Replay handleMessage failed', { activityId, error: (err as Error).message }),
    );
    return { ok: true };
  }

  /**
   * After a runner restart, walk the activities the sweep just marked as
   * `Interrupted — runner restarted` and replay each one that's still
   * relevant. Best-effort, sequential, with three safety gates:
   *
   *   1. **Age cap (30 min):** older interruptions are likely stale (user
   *      moved on, system state has drifted), so don't pester the channel.
   *   2. **Already-handled:** if a *newer* activity exists in the same task,
   *      the user (or another runner) already engaged — skip.
   *   3. **Crash-loop cap:** if the same task already has 3+ activities
   *      auto-replayed within the last hour, give up; something is wrong
   *      and we shouldn't keep burning tokens.
   *
   * On a successful kickoff, we tag the original row's `error` with
   * `[auto-replayed]` so it's excluded from future cycles. Set
   * `RUNNER_AUTO_REPLAY=0` in env to disable entirely.
   */
  private async autoReplaySweptActivities(activityIds: string[]): Promise<void> {
    const { getDb } = await import('@slackhive/shared');
    const db = getDb();
    const cutoff = new Date(Date.now() - 30 * 60 * 1_000).toISOString().replace('T', ' ').slice(0, 19);
    let attempted = 0;
    let skipped = 0;

    for (const id of activityIds) {
      try {
        const { rows } = await db.query(
          `SELECT started_at, task_id FROM activities WHERE id = $1`,
          [id],
        );
        if (rows.length === 0) { skipped++; continue; }
        const { started_at, task_id } = rows[0] as Record<string, string>;

        if (started_at < cutoff) {
          logger.info('Auto-replay skip: too old', { activityId: id, started_at });
          skipped++; continue;
        }

        const newer = await db.query(
          `SELECT 1 FROM activities WHERE task_id = $1 AND id != $2 AND started_at >= $3 LIMIT 1`,
          [task_id, id, started_at],
        );
        if (newer.rows.length > 0) {
          logger.info('Auto-replay skip: newer activity exists', { activityId: id });
          skipped++; continue;
        }

        const replays = await db.query(
          `SELECT COUNT(*) AS n FROM activities
            WHERE task_id = $1 AND started_at > datetime('now', '-1 hour')
              AND error LIKE '%[auto-replayed]%'`,
          [task_id],
        );
        if (Number((replays.rows[0] as Record<string, unknown>).n) >= 3) {
          logger.warn('Auto-replay skip: crash-loop cap hit (3 replays/hour)', { taskId: task_id });
          skipped++; continue;
        }

        const result = await this.replayActivity(id);
        if (result.ok) {
          attempted++;
          await db.query(
            `UPDATE activities SET error = COALESCE(error, '') || ' [auto-replayed]' WHERE id = $1`,
            [id],
          );
        } else {
          logger.warn('Auto-replay returned not-ok', { activityId: id, error: result.error });
          skipped++;
        }
      } catch (err) {
        logger.warn('Auto-replay failed', { activityId: id, error: (err as Error).message });
        skipped++;
      }
    }

    logger.info('Auto-replay sweep complete', { attempted, skipped, total: activityIds.length });
  }

  /**
   * Starts the runner:
   * 1. Connects to Redis for hot-reload events
   * 2. Loads and starts all active agents from the database
   * 3. Registers graceful shutdown handlers
   *
   * @returns {Promise<void>}
   * @throws {Error} If Redis connection fails.
   */
  async start(): Promise<void> {
    logger.info('AgentRunner starting...');

    await this.connectEventBus();
    await this.cleanupStaleRequests();
    let sweptActivityIds: string[] = [];
    try {
      sweptActivityIds = await sweepStaleActivities();
      if (sweptActivityIds.length > 0) logger.info('Swept stale in-progress activities', { count: sweptActivityIds.length });
    } catch (err) {
      logger.warn('Failed to sweep stale activities', { error: (err as Error).message });
    }
    await this.startInternalServer();
    await this.loadAllAgents();
    await this.jobScheduler.start();
    this.startHeartbeat();
    this.startPeriodicSweep();
    this.registerShutdownHandlers();

    // Background-fill any skill description that's still NULL — covers rows
    // saved while the runner was down or where a previous summarize call
    // crashed before completing. Fire-and-forget; safe to run after startup.
    this.sweepMissingSkillDescriptions().catch((err) =>
      logger.warn('Skill description sweep failed', { error: (err as Error).message })
    );

    logger.info('AgentRunner started', { agents: this.runningAgents.size, runnerId: this.runnerId });

    if (sweptActivityIds.length > 0 && process.env.RUNNER_AUTO_REPLAY !== '0') {
      // Fire-and-forget — don't block boot on Slack round-trips.
      void this.autoReplaySweptActivities(sweptActivityIds);
    }
  }

  /**
   * Bump last_heartbeat every 15s for all running agents we own. Lets the UI
   * detect a dead runner (no heartbeat for >45s → render `stale`) instead of
   * showing a stale "Running" dot forever.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const ids = Array.from(this.runningAgents.keys());
      if (ids.length === 0) return;
      heartbeatAgents(ids, this.runnerId).catch((err) =>
        logger.warn('Heartbeat write failed', { error: (err as Error).message })
      );
    }, 15_000);
    // Don't keep the event loop alive just for the heartbeat.
    this.heartbeatTimer.unref?.();
  }

  /** Sweep in_progress activities that were orphaned mid-run (every 2h). */
  private startPeriodicSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(async () => {
      try {
        const swept = await sweepStaleActivities();
        if (swept.length > 0) logger.info('Periodic sweep: marked stale activities as error', { count: swept.length });
      } catch (err) {
        logger.warn('Periodic sweep failed', { error: (err as Error).message });
      }
    }, 2 * 60 * 60 * 1000); // 2 hours
    this.sweepTimer.unref?.();
  }

  /**
   * On startup, mark any in-flight async requests as errored.
   * They were running when the server stopped — they can't be resumed.
   */
  private async cleanupStaleRequests(): Promise<void> {
    try {
      const { getDb } = await import('@slackhive/shared');
      const r = await getDb().query(
        "SELECT key, value FROM settings WHERE key LIKE 'analyze:%' OR key LIKE 'knowledge-build:%' OR key LIKE 'wiki-build:%'"
      );
      let cleaned = 0;
      for (const row of r.rows) {
        const key = row.key as string;
        try {
          const data = JSON.parse(row.value as string);
          if (data.status === 'pending' || data.status === 'running' || data.status === 'building') {
            await getDb().query(
              "UPDATE settings SET value = $1 WHERE key = $2",
              [JSON.stringify({ ...data, status: 'error', error: 'Cancelled — server restarted' }), key]
            );
            cleaned++;
          }
        } catch { /* skip invalid rows */ }
      }
      if (cleaned > 0) logger.info('Cleaned up stale in-flight requests', { count: cleaned });

      // Reset interrupted wiki_sources builds back to pending (building → pending only on restart)
      await getDb().query(
        "UPDATE wiki_sources SET status = 'pending' WHERE status = 'building'"
      );

      // Issue 4: remove any stale .build.lock files left by a crashed process
      const knowledgeDir = path.join(os.homedir(), '.slackhive', 'knowledge');
      if (fs.existsSync(knowledgeDir)) {
        for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const lockFile = path.join(knowledgeDir, entry.name, '.build.lock');
          if (fs.existsSync(lockFile)) {
            try { fs.unlinkSync(lockFile); } catch { /* ok */ }
            logger.info('Removed stale wiki build lock', { folder: entry.name });
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to clean stale requests', { error: (err as Error).message });
    }
  }

  /**
   * Gracefully stops all running agents and disconnects from Redis.
   *
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    logger.info('AgentRunner stopping...');

    // Stop heartbeat
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }

    // Stop internal server
    if (this.internalServer) { this.internalServer.close(); this.internalServer = null; }

    // Stop job scheduler
    await this.jobScheduler.stop();

    // Stop all agents concurrently
    const stopPromises = Array.from(this.runningAgents.keys()).map((id) =>
      this.stopAgent(id).catch((err) =>
        logger.warn('Error stopping agent during shutdown', { agentId: id, error: err.message })
      )
    );
    await Promise.all(stopPromises);

    if (this.eventBus) {
      await this.eventBus.close();
      this.eventBus = null;
    }

    logger.info('AgentRunner stopped');
  }

  // ===========================================================================
  // Agent lifecycle
  // ===========================================================================

  /**
   * Loads all agents from the database and starts each one.
   *
   * @returns {Promise<void>}
   */
  private async loadAllAgents(): Promise<void> {
    const agents = await getAllAgents();
    logger.info('Loading agents from database', { count: agents.length });

    // Reset statuses — at process boot no agent is actually running yet.
    // This clears stale 'error' rows left by zombie/racing runners from prior
    // sessions. The very next `startAgent` call sets the true current state.
    for (const agent of agents) {
      if (agent.enabled !== false) {
        await updateAgentStatus(agent.id, 'stopped', undefined, this.runnerId);
      }
    }

    // Start agents sequentially to avoid overwhelming Slack's rate limits.
    // Skip agents that are stopped or have placeholder/missing tokens.
    for (const agent of agents) {
      if (agent.enabled === false) {
        logger.info('Skipping disabled agent', { agent: agent.slug });
        continue;
      }
      // Token validation happens in startAgent after loading platform integration
      try {
        await this.startAgent(agent);
      } catch (err) {
        const msg = (err as Error).message;
        logger.error('Failed to start agent', { agent: agent.slug, error: msg });
        await updateAgentStatus(agent.id, 'error', msg, this.runnerId);
      }
    }
  }

  /**
   * Starts a single agent:
   * 1. Loads its MCP servers and permissions from the database
   * 2. Compiles CLAUDE.md from skills + memories
   * 3. Materializes memory files to disk
   * 4. Creates Bolt App + ClaudeHandler + MemoryWatcher
   * 5. Registers Slack event handlers
   * 6. Starts the Bolt App (opens Socket Mode connection)
   *
   * @param {Agent} agent - The agent to start.
   * @returns {Promise<void>}
   * @throws {Error} If Slack App fails to start.
   */
  private async startAgent(agent: Agent): Promise<void> {
    if (this.runningAgents.has(agent.id)) {
      logger.warn('Agent already running, skipping start', { agent: agent.slug });
      return;
    }

    logger.info('Starting agent', { agent: agent.slug });

    // Load configuration from DB
    // memories are loaded inside compileClaudeMd (inlined into CLAUDE.md).
    const [mcpServers, permissions, restrictions, envVarValues] = await Promise.all([
      getAgentMcpServers(agent.id),
      getAgentPermissions(agent.id),
      getAgentRestrictions(agent.id),
      getAllEnvVarValues(),
    ]);

    // Load platform integration from DB (needed for formatting rules in CLAUDE.md)
    const { updateAgentSlackUserId } = await import('./db');
    const integration = await getPlatformIntegration(agent.id, 'slack');
    if (!integration) {
      logger.warn('No platform integration found — agent cannot start', { agent: agent.slug });
      // 'stopped', not 'error' — this is a not-yet-configured state, not a runtime failure.
      await updateAgentStatus(agent.id, 'stopped', 'Slack is not configured for this agent.', this.runnerId);
      return;
    }

    // Create platform adapter
    const adapter = new SlackAdapter(
      { platform: 'slack', botToken: integration.credentials.botToken, appToken: integration.credentials.appToken, signingSecret: integration.credentials.signingSecret },
      agent.slug,
    );

    // Compile CLAUDE.md with platform-specific formatting rules.
    // compileClaudeMd inlines all learned memories directly into the system
    // prompt (no /recall skill needed) and inlines the wiki index when present.
    const workDir = await compileClaudeMd(agent, undefined, adapter.getFormattingRules());

    // Create Claude Code SDK handler
    const claudeHandler = new ClaudeHandler(agent, mcpServers, permissions, workDir, envVarValues);
    claudeHandler.initialize();

    // Create memory watcher (persists SDK memory writes back to DB)
    const memoryWatcher = new MemoryWatcher(agent);
    memoryWatcher.start();

    // Wire message handler: adapter → MessageHandler → ClaudeHandler
    const messageHandler = new MessageHandler(adapter, claudeHandler, agent, restrictions);
    adapter.onMessage(msg => messageHandler.handleMessage(msg));

    // Start the platform connection
    await adapter.start();

    // Store bot user ID discovered during start
    const botUserId = adapter.getBotUserId();
    if (botUserId && botUserId !== integration.botUserId) {
      await updateAgentSlackUserId(agent.id, botUserId);
      agent.slackBotUserId = botUserId;
    }

    this.runningAgents.set(agent.id, { agent, adapter, claudeHandler, messageHandler, memoryWatcher });
    // Success — clear any leftover error message from a prior failed start.
    await updateAgentStatus(agent.id, 'running', null, this.runnerId);

    logger.info('Agent started', {
      agent: agent.slug,
      mcpServers: mcpServers.map((m) => m.name),
    });
  }

  /**
   * Stops a running agent and cleans up all its resources.
   *
   * @param {string} agentId - UUID of the agent to stop.
   * @returns {Promise<void>}
   */
  private async stopAgent(agentId: string): Promise<void> {
    const running = this.runningAgents.get(agentId);
    if (!running) return;

    const { agent, adapter, claudeHandler, memoryWatcher } = running;
    logger.info('Stopping agent', { agent: agent.slug });

    memoryWatcher.stop();
    await claudeHandler.destroy();

    try {
      await adapter.stop();
    } catch (err) {
      logger.warn('Error stopping platform adapter', { agent: agent.slug, error: err });
    }

    this.runningAgents.delete(agentId);
    await updateAgentStatus(agentId, 'stopped', undefined, this.runnerId);

    logger.info('Agent stopped', { agent: agent.slug });
  }

  // ===========================================================================
  // Test sessions — ephemeral in-app agent previews
  // ===========================================================================

  /**
   * Lazily create a team test session rooted at `rootAgentId`. Reuses the
   * session on subsequent turns so multi-turn context (SDK session +
   * in-memory history) carries across messages in the same panel.
   *
   * The root participant (the agent the user opened Test on) is spun up
   * eagerly. Additional participants are lazy-added by `ensureParticipant`
   * when the orchestrator sees a `<@U...>` mention for them.
   */
  async getOrCreateTeamSession(rootAgentId: string, sessionId: string): Promise<TeamTestSession> {
    const key = `${rootAgentId}:${sessionId}`;
    const existing = this.testSessions.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const rootAgent = await getAgentById(rootAgentId);
    if (!rootAgent) throw new Error(`agent ${rootAgentId} not found`);

    // Compile the root agent's CLAUDE.md into its real workDir (deterministic;
    // safe to run in parallel with the live runtime) so we can clone from it.
    const rootAgentWorkDir = await compileClaudeMd(rootAgent, undefined, '');
    const workDirRoot = buildSessionRootDir(rootAgentWorkDir, sessionId, rootAgent.slug);

    const session: TeamTestSession = {
      rootAgentId,
      sessionId,
      participants: new Map(),
      history: [],
      workDirRoot,
      lastUsedAt: Date.now(),
    };
    this.testSessions.set(key, session);

    // Eagerly spin the root participant so the first turn doesn't pay the
    // cold-start cost inside the user-visible latency.
    await this.ensureParticipant(session, rootAgent);

    logger.info('Team test session created', { rootAgentId, sessionId, workDirRoot });

    // Best-effort idle sweep on every new session.
    this.reapIdleTestSessions();

    return session;
  }

  /**
   * Lazy-create a participant for `agent` in `session`. Returns existing
   * participant if already present. Called by the orchestrator when a
   * mention resolves to an agent not yet in the session.
   *
   * Each participant gets its own isolated workDir (memory writes stay
   * inside the session dir) but shares `session.history` so every agent's
   * `getThreadMessages` sees the full multi-bot thread.
   */
  async ensureParticipant(session: TeamTestSession, agent: Agent): Promise<AgentParticipant> {
    const existing = session.participants.get(agent.id);
    if (existing) return existing;

    const [permissions, envVarValues, integration, mcpServers] = await Promise.all([
      getAgentPermissions(agent.id),
      getAllEnvVarValues(),
      getPlatformIntegration(agent.id, 'slack'),
      getAgentMcpServers(agent.id),
    ]);

    // `getAgentById` reads the `agents` table only — the bot user ID lives in
    // `platform_integrations`. The orchestrator's mention routing + the
    // panel's `<@Uxxx>` rename both need it, so stamp it here.
    if (!agent.slackBotUserId && integration?.botUserId) {
      agent.slackBotUserId = integration.botUserId;
    }

    // Compile this agent's CLAUDE.md into its real workDir, then clone
    // into an isolated participant subdir so test-session memory writes
    // never leak into the Slack agent's sessions dir.
    const agentWorkDir = await compileClaudeMd(agent, undefined, '');
    const participantWorkDir = buildParticipantWorkDir(
      session.workDirRoot, agent.slug, agentWorkDir,
    );

    // Test sessions now get the agent's real MCP servers. ClaudeHandler's
    // McpProcessManager retries on port-in-use, so running alongside the live
    // Slack agent just lands the test proxies on neighbouring ports.
    const claudeHandler = new ClaudeHandler(agent, mcpServers, permissions, participantWorkDir, envVarValues);
    claudeHandler.initialize();

    const adapter = new TestAdapter(() => { /* emit target is set per turn by test-handler-server */ });
    adapter.setSharedHistory(session.history);
    adapter.setAgentRef({
      id: agent.id,
      name: agent.name,
      botUserId: agent.slackBotUserId,
    });
    if (agent.slackBotUserId) adapter.setBotUserId(agent.slackBotUserId);

    const messageHandler = new MessageHandler(adapter, claudeHandler, agent, null);
    adapter.onMessage(msg => messageHandler.handleMessage(msg));

    const participant: AgentParticipant = {
      agent, adapter, claudeHandler, messageHandler,
      workDir: participantWorkDir,
    };
    session.participants.set(agent.id, participant);
    logger.info('Participant added to test session', {
      rootAgentId: session.rootAgentId,
      sessionId: session.sessionId,
      participant: agent.slug,
    });
    return participant;
  }

  /** Tear down a team test session: destroy every participant's ClaudeHandler
   *  and rm -rf the whole session dir. */
  async destroyTestSession(rootAgentId: string, sessionId: string): Promise<void> {
    const key = `${rootAgentId}:${sessionId}`;
    const session = this.testSessions.get(key);
    if (!session) return;

    this.testSessions.delete(key);

    for (const p of session.participants.values()) {
      try { p.claudeHandler.destroy(); } catch { /* swallow */ }
    }

    try {
      const fsp = await import('fs/promises');
      await fsp.rm(session.workDirRoot, { recursive: true, force: true });
    } catch (err) {
      logger.warn('Failed to clean test workDir', {
        workDir: session.workDirRoot, error: (err as Error).message,
      });
    }
    logger.info('Team test session destroyed', { rootAgentId, sessionId });
  }

  private reapIdleTestSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.testSessions) {
      if (now - session.lastUsedAt > TEST_SESSION_IDLE_MS) {
        const [aid, sid] = key.split(':');
        this.destroyTestSession(aid, sid).catch(() => {});
      }
    }
  }

  /**
   * Reloads an agent: stops it, re-fetches its config, recompiles, and restarts.
   * Called when the web UI publishes a reload event.
   *
   * @param {string} agentId - UUID of the agent to reload.
   * @returns {Promise<void>}
   */
  private async reloadAgent(agentId: string): Promise<void> {
    logger.info('Reloading agent', { agentId });

    await this.stopAgent(agentId);

    const agent = await getAgentById(agentId);
    if (!agent) {
      logger.warn('Agent not found after reload event', { agentId });
      return;
    }

    await this.startAgent(agent);
  }

  // ===========================================================================
  // Event bus (Redis or in-memory)
  // ===========================================================================

  /**
   * Connects to the event bus and subscribes to agent lifecycle events.
   * Uses Redis if REDIS_URL is set, otherwise falls back to in-memory EventEmitter.
   *
   * @returns {Promise<void>}
   */
  private async connectEventBus(): Promise<void> {
    this.eventBus = getEventBus();

    await this.eventBus.subscribe((event: AgentEvent) => {
      logger.info('Received agent event', { event });

      switch (event.type) {
        case 'reload':
          this.reloadAgent(event.agentId).catch(async (err) => {
            logger.error('Failed to reload agent', { agentId: event.agentId, error: err.message });
            await updateAgentStatus(event.agentId, 'error', err.message, this.runnerId).catch(() => {});
          });
          break;
        case 'start':
          getAgentById(event.agentId)
            .then((agent) => agent && this.startAgent(agent))
            .catch(async (err) => {
              logger.error('Failed to start agent', { agentId: event.agentId, error: err.message });
              await updateAgentStatus(event.agentId, 'error', err.message, this.runnerId).catch(() => {});
            });
          break;
        case 'stop':
          this.stopAgent(event.agentId).catch((err) =>
            logger.error('Failed to stop agent', { agentId: event.agentId, error: err.message })
          );
          break;
        case 'reload-jobs':
          this.jobScheduler.reload().catch((err) =>
            logger.error('Failed to reload jobs', { error: (err as Error).message })
          );
          break;
        case 'skill-saved':
          this.summarizeSkillIfNeeded(event.agentId, event.skillId).catch((err) =>
            logger.warn('Skill summarize failed', { skillId: event.skillId, error: err.message })
          );
          break;
        case 'user-access-changed':
        case 'env-vars-changed':
          // Cache invalidation events — single dispatcher in access-cache.ts
          // so the routing lives next to the caches it touches.
          dispatchCacheEvent(event);
          break;
      }
    });

    logger.info('Event bus connected', { type: this.eventBus.type });
  }

  // ===========================================================================
  // Internal HTTP server — receives events from the web process
  // ===========================================================================

  /**
   * Starts a lightweight HTTP server on RUNNER_INTERNAL_PORT (default 3002).
   * The web process POSTs agent lifecycle events here instead of using
   * the in-memory event bus (which doesn't cross process boundaries).
   */
  private async startInternalServer(): Promise<void> {
    const http = await import('http');
    const port = parseInt(process.env.RUNNER_INTERNAL_PORT ?? '3002', 10);

    this.internalServer = http.createServer(async (req, res) => {
      // Streaming coach turn — writes SSE events directly to the response.
      if (req.method === 'POST' && req.url === '/coach') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { handleCoachStream } = await import('./coach-handler-server');
            await handleCoachStream(body, res);
          } catch (err) {
            logger.error('Coach stream error', { error: (err as Error).message });
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            } else {
              res.end();
            }
          }
        });
        return;
      }

      // Test-mode turn — SSE preview of the agent's runtime.
      if (req.url === '/test' && (req.method === 'POST' || req.method === 'DELETE')) {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { handleTestStream, handleTestDelete } = await import('./test-handler-server');
            if (req.method === 'POST') await handleTestStream(body, res, this);
            else await handleTestDelete(body, res, this);
          } catch (err) {
            logger.error('Test stream error', { error: (err as Error).message });
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            } else {
              res.end();
            }
          }
        });
        return;
      }

      // AI polish for audience-group instructions (single Claude turn, no SSE).
      if (req.method === 'POST' && req.url === '/polish-audience-instructions') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const input = JSON.parse(body) as {
              audienceName?: string;
              audienceDescription?: string | null;
              agentName?: string;
              agentDescription?: string | null;
              verbose?: boolean;
              draft?: string;
            };
            if (!input.audienceName || !input.agentName) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'audienceName and agentName required' }));
              return;
            }
            const { polishAudienceInstructions } = await import('./polish-audience-instructions');
            const text = await polishAudienceInstructions({
              audienceName: input.audienceName,
              audienceDescription: input.audienceDescription ?? null,
              agentName: input.agentName,
              agentDescription: input.agentDescription ?? null,
              verbose: !!input.verbose,
              draft: input.draft ?? '',
            });
            if (text == null) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'polish failed' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        });
        return;
      }

      // Replay an errored / interrupted activity by feeding its original
      // message back through the live MessageHandler.
      if (req.method === 'POST' && req.url === '/replay-activity') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { activityId } = JSON.parse(body) as { activityId?: string };
            const result = await this.replayActivity(activityId ?? '');
            res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          }
        });
        return;
      }

      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const event = JSON.parse(body) as AgentEvent;
          logger.info('Internal event received', { event });

          switch (event.type) {
            case 'reload':
              await this.reloadAgent(event.agentId);
              break;
            case 'start':
              const agent = await getAgentById(event.agentId);
              if (agent) {
                try {
                  await this.startAgent(agent);
                } catch (err) {
                  const msg = (err as Error).message;
                  logger.error('Failed to start agent', { agent: agent.slug, error: msg });
                  await updateAgentStatus(agent.id, 'error', msg, this.runnerId);
                  throw err;
                }
              }
              break;
            case 'stop':
              await this.stopAgent(event.agentId);
              break;
            case 'reload-jobs':
              await this.jobScheduler.reload();
              break;
            case 'skill-saved':
              this.summarizeSkillIfNeeded(event.agentId, event.skillId).catch((err) =>
                logger.warn('Skill summarize failed', { skillId: event.skillId, error: err.message })
              );
              break;
            case 'user-access-changed':
            case 'env-vars-changed':
              dispatchCacheEvent(event);
              break;
            default: {
              // Handle mcp-auth, analyze-memories, and other custom events
              const raw = event as any;
              if (raw.type === 'mcp-auth') {
                this.authenticateMcp(raw.requestId, raw.mcpUrl, raw.mcpName).catch(err =>
                  logger.error('MCP auth failed', { error: err.message })
                );
              }
              if (raw.type === 'analyze-memories') {
                this.analyzeMemories(raw.agentId, raw.requestId).catch(err =>
                  logger.error('Memory analysis failed', { error: err.message })
                );
              }
              if (raw.type === 'build-knowledge') {
                this.buildKnowledgeWiki(raw.agentId, raw.requestId).catch(err =>
                  logger.error('Knowledge build failed', { error: err.message })
                );
              }
              if (raw.type === 'ingest-source') {
                this.ingestSingleSource(raw.agentId, raw.sourceId, raw.requestId).catch(err =>
                  logger.error('Source ingest failed', { error: err.message })
                );
              }
              if (raw.type === 'build-wiki-folder') {
                this.buildWikiFolderSources(raw.folderId, raw.requestId, raw.scratch === true).catch(err =>
                  logger.error('Wiki folder build failed', { error: err.message })
                );
              }
              if (raw.type === 'build-wiki-source') {
                this.buildWikiFolderSources(raw.folderId, raw.requestId, false, raw.sourceId).catch(err =>
                  logger.error('Wiki source build failed', { error: err.message })
                );
              }
              break;
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          logger.error('Internal event error', { error: (err as Error).message });
          res.writeHead(500);
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
    });

    // Bind the internal server. A runner without this endpoint is broken —
    // the web UI can't dispatch agent reload/start/stop/MCP-auth events. The CLI
    // pre-scans for a free port before spawning us, so hitting EADDRINUSE here
    // means a race (another process bound between the pre-scan and now) or a
    // user ran the runner directly without the CLI. Fail fast with a clear log
    // instead of silently hanging.
    this.internalServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`Internal server port ${port} is already in use. Run 'slackhive stop' and retry, or set RUNNER_INTERNAL_PORT to a free port.`);
      } else {
        logger.error('Internal server bind failed', { port, error: err.message });
      }
      process.exit(1);
    });
    this.internalServer.listen(port, '127.0.0.1', () => {
      logger.info('Internal event server started', { port });
    });
  }

  // ===========================================================================
  // Graceful shutdown
  // ===========================================================================

  /**
   * Registers SIGTERM and SIGINT handlers for graceful shutdown.
   * Ensures all agents are cleanly stopped before the process exits.
   *
   * @returns {void}
   */
  private registerShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      // Set BEFORE this.stop() so any in-flight MessageHandler aborts that
      // fire during shutdown leave their activity rows as `in_progress`.
      // The next process's sweep will pick them up and auto-replay them.
      markShuttingDown();
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // ===========================================================================
  // Claude SDK call with auth retry chain
  // ===========================================================================

  /**
   * Calls Claude SDK with auth retry:
   * 1. Try SDK call
   * 2. On auth error → sync from Keychain (macOS) → retry
   * 3. On auth error → refresh token via OAuth endpoint → retry
   * 4. On auth error → throw AUTH_NEEDS_LOGIN
   */
  /**
   * Analyzes an agent's memories and suggests actions: move_to_skill, update_prompt, merge, delete.
   * Result is stored in the DB for the web UI to poll.
   */
  /**
   * Builds the knowledge wiki from all sources for an agent.
   * For git repos: clones to temp dir, reads files, deletes clone.
   * For URLs/files: reads content from DB.
   * Calls Claude to compile structured wiki articles.
   */
  // ─── Knowledge Wiki (Karpathy Incremental Ingest) ────────────────────────

  /**
   * Reads a git repo for wiki compilation. Returns:
   *   - `content`: the repo content as a single string for Claude.
   *   - `currentSha`: HEAD SHA after clone (empty string if `git rev-parse`
   *     fails for any reason).
   *   - `diff`: when a `lastSha` was supplied AND it's reachable from HEAD via
   *     incremental `git fetch --deepen`, the changed-files list against
   *     that SHA. The `content` in this case is *focused* on the diff (only
   *     changed/added/renamed file bodies + a small README context block,
   *     not the whole repo) which dramatically reduces token cost on small
   *     re-syncs. When the diff can't be computed (no `lastSha`, force-push,
   *     branch swap, deepen failure), returns `diff: null` and a full
   *     snapshot in `content` — same behavior as before.
   *
   * @param src The wiki_sources row for this source.
   * @param lastSha Optional commit SHA from a prior successful sync. When
   *   provided AND reachable, the function returns a diff-focused content
   *   string. When omitted or unreachable, falls back to full snapshot.
   */
  private async readRepoContent(
    src: Record<string, unknown>,
    lastSha?: string | null,
  ): Promise<{ content: string; currentSha: string; diff: RepoDiff | null }> {
    const fs = await import('fs');
    const path = await import('path');
    const { execSync } = await import('child_process');
    const tmpDir = path.join('/tmp', `slackhive-repo-${src.id}`);

    // Hard cap on total content fed to Claude (~500k chars ≈ ~125k tokens, well under limit).
    // Sections are added highest-priority first; once budget is exhausted we stop.
    const TOTAL_BUDGET = 500_000;
    let budgetUsed = 0;
    const budgetSection = (title: string, content: string): string => {
      if (!content.trim() || budgetUsed >= TOTAL_BUDGET) return '';
      const remaining = TOTAL_BUDGET - budgetUsed;
      const truncated = content.length > remaining ? content.slice(0, remaining) + '\n…[truncated — budget exhausted]' : content;
      budgetUsed += truncated.length;
      return `\n## ${title}\n${truncated}`;
    };

    // Helper: safe read file
    const read = (p: string, max = 0) => {
      try { const c = fs.readFileSync(p, 'utf-8'); return max ? c.slice(0, max) : c; } catch { return ''; }
    };
    // Helper: find files matching pattern, excluding noise
    const findFiles = (pattern: string, maxDepth = 6, limit = 500): string[] => {
      try {
        return execSync(
          `find "${tmpDir}" -maxdepth ${maxDepth} -type f ${pattern} ` +
          `-not -path "*/node_modules/*" -not -path "*/.git/*" ` +
          `-not -path "*/dist/*" -not -path "*/.next/*" -not -path "*/.nuxt/*" ` +
          `-not -path "*/__pycache__/*" -not -path "*/venv/*" -not -path "*/.venv/*" ` +
          `-not -path "*/target/*" -not -path "*/.cache/*" -not -path "*/build/*" ` +
          `-not -path "*/vendor/*" -not -path "*/.tox/*" ` +
          `| head -${limit}`,
          { encoding: 'utf-8', timeout: 10000 }
        ).trim().split('\n').filter(Boolean);
      } catch { return []; }
    };
    const rel = (p: string) => p.replace(tmpDir + '/', '');

    const fileBlock = (relPath: string, content: string) => `\n### ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`;

    try {
      let cloneUrl = src.repo_url as string;
      if (src.pat_env_ref) {
        const envVars = await getAllEnvVarValues();
        const pat = envVars[src.pat_env_ref as string];
        if (pat && cloneUrl.startsWith('https://')) {
          const u = new URL(cloneUrl);
          u.username = pat;
          cloneUrl = u.toString();
        }
      }

      const branch = (src.branch as string) || 'main';
      // Pre-flight: wipe tmpDir if a previous run was killed mid-clone (SIGTERM
      // skips the finally cleanup). git clone refuses to write into a
      // non-empty directory, so a stale dir would block this run forever.
      // Use fs.rmSync (no shell) so no chance of metachar interpolation
      // through the path even if src.id ever ceases to be a UUID.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
      try {
        // Capture stderr so a clone failure surfaces git's actual error
        // ("Remote branch foo not found", auth failure, etc.) — previously
        // the catch only got "Command failed: …" with no useful detail.
        execSync(`git clone --depth 1 --branch "${branch}" "${cloneUrl}" "${tmpDir}"`, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
      } catch (err) {
        // Redact the URL (it contains the PAT in basic-auth form). Re-throw
        // a descriptive error so the upstream catch records the real reason.
        const stderr = ((err as { stderr?: Buffer }).stderr?.toString() ?? '').trim();
        const safeUrl = (src.repo_url as string) ?? '<unknown>';
        const reason = stderr || (err as Error).message;
        throw new Error(`git clone failed for ${src.name} (${safeUrl} @ ${branch}): ${reason}`);
      }

      // Capture HEAD SHA — always returned to the caller so it can persist
      // last_synced_sha after a successful build. Never fails the function;
      // we'd rather lose incremental optimisation than break the build.
      let currentSha = '';
      try {
        currentSha = execSync(`git -C "${tmpDir}" rev-parse HEAD`, { encoding: 'utf-8', timeout: 10000 }).trim();
      } catch (err) {
        logger.warn('[wiki] Failed to read HEAD SHA — incremental sync disabled for this run', {
          source: src.name as string, error: (err as Error).message,
        });
      }

      // Try to compute a diff against `lastSha` so we can send Claude only
      // the changed files. Bails out (returns null diff → falls back to
      // full snapshot) on any failure path:
      //   - lastSha not provided (first sync)
      //   - lastSha == currentSha (no work — caller will short-circuit)
      //   - branch was force-pushed, swapped, or rewritten (lastSha not
      //     reachable from HEAD even after deepening)
      //   - server doesn't allow `--deepen` fetches
      let diff: RepoDiff | null = null;
      if (lastSha && currentSha && lastSha !== currentSha) {
        diff = await this.tryComputeRepoDiff(tmpDir, lastSha, branch, execSync);
      }

      // Diff-focused content path: dramatically smaller prompt for incremental
      // syncs. Only the changed/added/renamed file bodies + a small README
      // context block, plus an explicit deleted-files list so Claude can mark
      // referencing articles for cleanup.
      if (diff) {
        const diffContent = this.buildDiffFocusedRepoContent(
          tmpDir, diff, src, lastSha!, currentSha, branch, read, fileBlock, budgetSection,
        );
        logger.info('Repo diff read', {
          source: src.name as string,
          chars: diffContent.length,
          added: diff.added.length, modified: diff.modified.length,
          deleted: diff.deleted.length, renamed: diff.renamed.length,
        });
        return { content: diffContent, currentSha, diff };
      }

      const sections: string[] = [];
      const header = `# Repository: ${src.name}\nBranch: ${branch} | URL: ${src.repo_url}`;
      budgetUsed += header.length;
      sections.push(header);

      // ─── 1. Documentation ──────────────────────────────────────────
      let readme = '';
      for (const f of ['README.md', 'readme.md', 'README.rst', 'README', 'docs/README.md']) {
        const c = read(path.join(tmpDir, f));
        if (c) { readme = c; break; }
      }
      sections.push(budgetSection('README', readme));

      let docs = '';
      for (const f of ['CONTRIBUTING.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md', 'docs/api.md', 'API.md', 'CLAUDE.md', 'AGENTS.md', 'docs/design.md', 'DESIGN.md']) {
        const c = read(path.join(tmpDir, f), 6000);
        if (c) docs += fileBlock(f, c);
      }
      sections.push(budgetSection('Documentation', docs));

      // ─── 2. Directory tree (full picture first) ────────────────────
      let tree = '';
      try {
        tree = execSync(
          `find "${tmpDir}" -maxdepth 5 -type f ` +
          `-not -path "*/node_modules/*" -not -path "*/.git/*" ` +
          `-not -path "*/dist/*" -not -path "*/.next/*" ` +
          `-not -path "*/__pycache__/*" -not -path "*/venv/*" ` +
          `-not -path "*/target/*" -not -path "*/.cache/*" -not -path "*/vendor/*" ` +
          `| sort | head -400`,
          { encoding: 'utf-8', timeout: 10000 }
        ).replace(new RegExp(tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.');
      } catch { /* ok */ }
      sections.push(budgetSection('Directory Structure', '```\n' + tree + '\n```'));

      // ─── 3. Code structure map (classes, functions, exports) ───────
      // Extract structural outline from ALL source files — gives Claude
      // a complete map even for files not read fully later.
      const allSrcForMap = findFiles(
        '\\( -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.go" ' +
        '-o -name "*.rs" -o -name "*.java" -o -name "*.js" -o -name "*.jsx" ' +
        '-o -name "*.rb" -o -name "*.kt" -o -name "*.swift" \\)',
        6, 500
      ).filter(f => !f.includes('node_modules') && !f.includes('.test.') && !f.includes('.spec.') && !f.includes('__tests__'));

      let codeMap = '';
      for (const f of allSrcForMap) {
        const content = read(f);
        if (!content) continue;
        const relPath = rel(f);
        const lines: string[] = [];

        // Extract imports (first 30 lines typically)
        const imports = content.split('\n').filter(l =>
          /^\s*(import |from |require\(|use |using |#include)/.test(l)
        ).slice(0, 15);
        if (imports.length) lines.push('  imports: ' + imports.map(i => i.trim()).join('; ').slice(0, 300));

        // Extract class/struct/interface definitions
        const classMatches = content.matchAll(
          /^(?:export\s+)?(?:abstract\s+)?(?:class|struct|interface|enum|type|trait|protocol)\s+(\w+)(?:\s*(?:extends|implements|<|:|\().*)?/gm
        );
        for (const m of classMatches) lines.push('  class: ' + m[0].trim().slice(0, 200));

        // Python classes
        const pyClasses = content.matchAll(/^class\s+(\w+)(?:\(.*?\))?:/gm);
        for (const m of pyClasses) lines.push('  class: ' + m[0].trim());

        // Function/method signatures (exported or top-level)
        const fnMatches = content.matchAll(
          /^(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+)(\w+)\s*(?:=\s*(?:async\s*)?\(|[(<])/gm
        );
        for (const m of fnMatches) lines.push('  fn: ' + m[0].trim().slice(0, 150));

        // Python functions
        const pyFns = content.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(.*?\)(?:\s*->.*?)?:/gm);
        for (const m of pyFns) lines.push('  fn: ' + m[0].trim().slice(0, 150));

        // Go functions
        const goFns = content.matchAll(/^func\s+(?:\(.*?\)\s+)?(\w+)\s*\(.*?\)(?:\s*(?:\(.*?\)|[\w.]+))?\s*\{/gm);
        for (const m of goFns) lines.push('  fn: ' + m[0].replace('{', '').trim().slice(0, 150));

        // Rust functions
        const rsFns = content.matchAll(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)(?:<.*?>)?\s*\(.*?\)(?:\s*->.*?)?\s*\{/gm);
        for (const m of rsFns) lines.push('  fn: ' + m[0].replace('{', '').trim().slice(0, 150));

        // Java methods (inside classes)
        const javaMethods = content.matchAll(/^\s+(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/gm);
        for (const m of javaMethods) lines.push('  method: ' + m[0].trim().slice(0, 150));

        // Exports
        const exports = content.matchAll(/^(?:export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)|module\.exports\s*=)/gm);
        const exportNames: string[] = [];
        for (const m of exports) if (m[1]) exportNames.push(m[1]);
        if (exportNames.length) lines.push('  exports: ' + exportNames.join(', '));

        if (lines.length > 0) {
          codeMap += `${relPath}\n${lines.join('\n')}\n`;
        }
      }
      sections.push(budgetSection('Code Structure Map', '```\n' + codeMap + '\n```'));

      // ─── 4. Dependencies & libraries ───────────────────────────────
      let deps = '';
      // JS/TS ecosystem
      for (const f of ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
        const c = read(path.join(tmpDir, f), f === 'package.json' ? 8000 : 0);
        if (c && f === 'package.json') deps += fileBlock(f, c);
      }
      // Python ecosystem
      for (const f of ['requirements.txt', 'Pipfile', 'pyproject.toml', 'setup.py', 'setup.cfg', 'poetry.lock']) {
        const c = read(path.join(tmpDir, f), 6000);
        if (c) deps += fileBlock(f, c);
      }
      // Other ecosystems
      for (const f of ['Cargo.toml', 'go.mod', 'go.sum', 'Gemfile', 'build.gradle', 'pom.xml', 'mix.exs', 'composer.json']) {
        const c = read(path.join(tmpDir, f), 4000);
        if (c) deps += fileBlock(f, c);
      }
      // Monorepo: sub-package manifests
      for (const f of findFiles('-name "package.json" -o -name "pyproject.toml" -o -name "Cargo.toml"', 3, 20)) {
        if (f === path.join(tmpDir, 'package.json')) continue;
        deps += fileBlock(rel(f), read(f, 3000));
      }
      sections.push(budgetSection('Dependencies & Libraries', deps));

      // ─── 4. Database schemas & migrations ──────────────────────────
      let dbSection = '';
      // SQL migrations
      const sqlFiles = findFiles('\\( -name "*.sql" \\)', 6, 30);
      for (const f of sqlFiles.slice(0, 15)) {
        dbSection += fileBlock(rel(f), read(f, 6000));
      }
      // ORM schema files (Prisma, SQLAlchemy, Django, TypeORM, Drizzle, Sequelize)
      const schemaFiles = findFiles(
        '\\( -name "schema.prisma" -o -name "schema.ts" -o -name "schema.py" ' +
        '-o -name "models.py" -o -name "models.ts" -o -name "*.entity.ts" ' +
        '-o -name "drizzle.config.*" -o -name "migration.*" ' +
        '-o -name "*.model.ts" -o -name "*.model.py" -o -name "*.model.js" \\)',
        6, 30
      );
      for (const f of schemaFiles) {
        dbSection += fileBlock(rel(f), read(f, 6000));
      }
      sections.push(budgetSection('Database Schemas & Migrations', dbSection));

      // ─── 5. API definitions ────────────────────────────────────────
      let apiSection = '';
      // OpenAPI / Swagger
      const apiFiles = findFiles(
        '\\( -name "openapi.*" -o -name "swagger.*" -o -name "*.graphql" ' +
        '-o -name "*.gql" -o -name "*.proto" -o -name "schema.graphql" ' +
        '-o -name "*.openapi.yaml" -o -name "*.openapi.json" \\)',
        6, 20
      );
      for (const f of apiFiles) {
        apiSection += fileBlock(rel(f), read(f, 8000));
      }
      sections.push(budgetSection('API Definitions', apiSection));

      // ─── 6. Configuration & environment ────────────────────────────
      let configSection = '';
      for (const f of [
        'tsconfig.json', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
        '.env.example', '.env.sample', 'config.yaml', 'config.yml', 'config.json',
        'settings.py', 'config.py', 'application.yml', 'application.properties',
        '.github/workflows/ci.yml', '.github/workflows/deploy.yml',
        'nx.json', 'turbo.json', 'lerna.json', 'pnpm-workspace.yaml',
        'next.config.js', 'next.config.ts', 'vite.config.ts', 'webpack.config.js',
        'jest.config.js', 'jest.config.ts', 'vitest.config.ts',
      ]) {
        const c = read(path.join(tmpDir, f), 4000);
        if (c) configSection += fileBlock(f, c);
      }
      sections.push(budgetSection('Configuration & Environment', configSection));

      // ─── 7. Entry points & main files ──────────────────────────────
      let entrySection = '';
      const entryPatterns = [
        'index.ts', 'index.js', 'main.ts', 'main.py', 'main.go', 'main.rs',
        'app.ts', 'app.py', 'app.js', 'server.ts', 'server.py', 'server.js',
        'cli.ts', 'cli.py', '__main__.py', 'manage.py', 'wsgi.py', 'asgi.py',
        'cmd/main.go', 'src/main.rs', 'src/lib.rs',
      ];
      for (const f of entryPatterns) {
        const c = read(path.join(tmpDir, f), 8000);
        if (c) entrySection += fileBlock(f, c);
      }
      // Also find entry points in src/ directories
      for (const f of findFiles('\\( -name "index.ts" -o -name "index.js" -o -name "main.py" -o -name "__init__.py" -o -name "mod.rs" \\)', 3, 30)) {
        const r = rel(f);
        if (!entryPatterns.includes(r) && !r.includes('node_modules')) {
          entrySection += fileBlock(r, read(f, 5000));
        }
      }
      sections.push(budgetSection('Entry Points', entrySection));

      // ─── 8. Types, models & interfaces ─────────────────────────────
      let typesSection = '';
      const typeFiles = findFiles(
        '\\( -name "types.ts" -o -name "types.py" -o -name "interfaces.ts" ' +
        '-o -name "*.types.ts" -o -name "*.interface.ts" -o -name "*.d.ts" ' +
        '-o -name "types.go" -o -name "structs.go" ' +
        '-o -name "schemas.py" -o -name "serializers.py" ' +
        '-o -name "*.dto.ts" -o -name "*.input.ts" \\)',
        6, 40
      );
      // Exclude .d.ts from dependencies
      for (const f of typeFiles.filter(f => !f.includes('node_modules')).slice(0, 20)) {
        typesSection += fileBlock(rel(f), read(f, 6000));
      }
      sections.push(budgetSection('Types, Models & Interfaces', typesSection));

      // ─── 9. Routes, handlers & controllers ─────────────────────────
      let routesSection = '';
      const routeFiles = findFiles(
        '\\( -name "*route*" -o -name "*router*" -o -name "*controller*" ' +
        '-o -name "*handler*" -o -name "*endpoint*" -o -name "*view*" ' +
        '-o -name "*resolver*" -o -name "urls.py" -o -name "views.py" \\)',
        6, 40
      );
      for (const f of routeFiles.filter(f => !f.includes('node_modules') && !f.includes('.test.')).slice(0, 20)) {
        routesSection += fileBlock(rel(f), read(f, 5000));
      }
      sections.push(budgetSection('Routes, Handlers & Controllers', routesSection));

      // ─── 10. Services, business logic ──────────────────────────────
      let servicesSection = '';
      const serviceFiles = findFiles(
        '\\( -name "*service*" -o -name "*manager*" -o -name "*provider*" ' +
        '-o -name "*repository*" -o -name "*adapter*" -o -name "*client*" ' +
        '-o -name "*worker*" -o -name "*processor*" -o -name "*engine*" ' +
        '-o -name "*pipeline*" -o -name "*task*" \\)',
        6, 60
      );
      for (const f of serviceFiles.filter(f => !f.includes('node_modules') && !f.includes('.test.') && !f.includes('.spec.')).slice(0, 25)) {
        servicesSection += fileBlock(rel(f), read(f, 5000));
      }
      sections.push(budgetSection('Services & Business Logic', servicesSection));

      // ─── 11. Remaining source files ────────────────────────────────
      // Files not yet captured by any category above
      const allSrcExts = '\\( -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.js" -o -name "*.jsx" -o -name "*.rb" -o -name "*.kt" -o -name "*.swift" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" \\)';
      const allSrc = findFiles(allSrcExts, 6, 500)
        .filter(f => !f.includes('node_modules') && !f.includes('.test.') && !f.includes('.spec.') && !f.includes('__tests__'));
      // Collect paths already included
      const alreadyIncluded = new Set([
        ...sqlFiles, ...schemaFiles, ...apiFiles, ...typeFiles, ...routeFiles, ...serviceFiles,
      ]);
      const remaining = allSrc.filter(f => !alreadyIncluded.has(f));
      let otherFiles = '';
      for (const f of remaining.slice(0, 40)) {
        otherFiles += fileBlock(rel(f), read(f, 3000));
      }
      sections.push(budgetSection(`Other Source Files (${remaining.length} total, showing ${Math.min(40, remaining.length)})`, otherFiles));

      // ─── 12. Test files (sample for patterns) ─────────────────────
      let testSection = '';
      const testFiles = findFiles('\\( -name "*.test.*" -o -name "*.spec.*" -o -name "test_*" -o -name "*_test.go" -o -name "*_test.py" \\)', 6, 20);
      for (const f of testFiles.slice(0, 5)) {
        testSection += fileBlock(rel(f), read(f, 2000));
      }
      sections.push(budgetSection('Test Files (sample)', testSection));

      const result = sections.filter(s => s.trim()).join('\n');
      logger.info('Repo content read', { source: src.name as string, chars: budgetUsed, capped: budgetUsed >= TOTAL_BUDGET });
      return { content: result, currentSha, diff: null };

    } finally {
      // No-shell cleanup — see pre-flight rmSync above for rationale.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }

  /**
   * Try to compute a diff against `lastSha` by incrementally deepening the
   * shallow clone until that commit becomes reachable. Returns parsed diff
   * on success, `null` on any failure (force-push, branch swap, server
   * rejection, lastSha never on this branch, etc.) so the caller falls back
   * to the full snapshot path. Capped at 1000-commit deepening to avoid
   * pulling massive history on long-lived repos.
   */
  private async tryComputeRepoDiff(
    tmpDir: string,
    lastSha: string,
    branch: string,
    execSync: typeof import('child_process').execSync,
  ): Promise<RepoDiff | null> {
    for (const depth of [50, 200, 1000]) {
      try {
        execSync(`git -C "${tmpDir}" fetch --deepen=${depth} origin "${branch}"`, {
          stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000,
        });
      } catch {
        continue;
      }
      try {
        execSync(`git -C "${tmpDir}" cat-file -e "${lastSha}^{commit}"`, { stdio: 'ignore' });
      } catch {
        continue; // lastSha still not reachable, try deeper
      }
      // Reachable — compute the diff. -M turns on rename detection.
      try {
        const out = execSync(
          `git -C "${tmpDir}" diff --name-status -M "${lastSha}..HEAD"`,
          { encoding: 'utf-8', timeout: 30_000 },
        );
        return parseDiffNameStatus(out);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Build a diff-focused content block for Claude. See the free-function
   * implementation in `buildDiffFocusedRepoContent` below — kept as a thin
   * wrapper so the call site inside `readRepoContent` stays unchanged while
   * the logic is independently testable from outside the AgentRunner class.
   */
  private buildDiffFocusedRepoContent(
    tmpDir: string,
    diff: RepoDiff,
    src: Record<string, unknown>,
    lastSha: string,
    currentSha: string,
    branch: string,
    read: (p: string, max?: number) => string,
    fileBlock: (relPath: string, content: string) => string,
    budgetSection: (title: string, content: string) => string,
  ): string {
    return buildDiffFocusedRepoContent(tmpDir, diff, src, lastSha, currentSha, branch, read, fileBlock, budgetSection);
  }

  /** Parse JSON from Claude response, trying multiple strategies. */
  private parseWikiJson(response: string): any | null {
    for (const strategy of [
      () => JSON.parse(response),
      () => { const m = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/); return m ? JSON.parse(m[1]) : null; },
      () => { const s = response.indexOf('{'); const e = response.lastIndexOf('}'); return s >= 0 && e > s ? JSON.parse(response.slice(s, e + 1)) : null; },
    ]) {
      try { const p = strategy(); if (p) return p; } catch { /* try next */ }
    }
    return null;
  }

  /** Read existing wiki state: article paths + titles + first lines. */
  private readExistingWiki(wikiDir: string): string {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    if (!fs.existsSync(wikiDir)) return '(empty — no wiki yet)';

    const articles: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.name.endsWith('.md')) {
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
          const titleMatch = content.match(/^#\s+(.+)/m);
          const title = titleMatch ? titleMatch[1] : entry.name.replace('.md', '');
          // First 2 meaningful lines after title
          const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 2).join(' ').slice(0, 200);
          articles.push(`- [${title}](${relPath}) — ${lines}`);
        }
      }
    };
    walk(wikiDir, '');
    return articles.length > 0 ? articles.join('\n') : '(empty — no wiki yet)';
  }

  /**
   * Ingest a single source into the wiki (Karpathy incremental pattern).
   * Reads the source fully, sees existing wiki, updates/creates articles.
   */
  private async ingestSource(
    agentId: string,
    sourceId: string,
    requestId: string,
    mode: 'ingest' | 'sync' = 'ingest',
  ): Promise<{ created: number; updated: number }> {
    const fs = await import('fs');
    const path = await import('path');
    const { getDb } = await import('@slackhive/shared');
    const { getAgentWorkDir } = await import('./compile-claude-md');

    const agent = await getAgentById(agentId);
    if (!agent) throw new Error('Agent not found');

    const r = await getDb().query('SELECT * FROM knowledge_sources WHERE id = $1', [sourceId]);
    const src = r.rows[0];
    if (!src) throw new Error('Source not found');

    const srcName = src.name as string;
    const srcType = src.type as string;
    const wikiDir = path.join(getAgentWorkDir(agent.slug), 'knowledge', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });

    const updateStatus = async (step: string) => {
      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'building', startedAt: Date.now(), step,
      }));
    };

    // 1. Read source content fully
    let content = '';
    if (srcType === 'url' || srcType === 'file') {
      content = (src.content as string) || '';
      if (!content) throw new Error(`Source "${srcName}" has no content`);
    } else if (srcType === 'repo') {
      await updateStatus(`Cloning ${srcName}...`);
      // Older ingestSource path — no per-source last_synced_sha tracking
      // here yet, so always pulls a full snapshot. Migrate this caller
      // when/if we need diff-aware sync for direct knowledge_sources too.
      const repoResult = await this.readRepoContent(src);
      content = repoResult.content;
    }

    // 2. Read existing wiki state + manifest
    const existingWiki = this.readExistingWiki(wikiDir);
    const wikiIsEmpty = existingWiki === '(empty — no wiki yet)';

    // Read manifest to check if this source was ever ingested
    const manifestPath = path.join(wikiDir, 'manifest.json');
    let manifest: Record<string, { created: string[]; updated: string[] }> = {};
    try {
      if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch { /* ok */ }
    const sourceEverIngested = !!manifest[srcName];

    // Determine effective mode: new source that was never ingested gets full treatment
    const effectiveMode = wikiIsEmpty ? 'first' : (sourceEverIngested && mode === 'sync') ? 'sync' : 'new-source';

    // 3. Call Claude
    await updateStatus(`${effectiveMode === 'sync' ? 'Syncing' : 'Ingesting'} ${srcName}...`);
    const now = new Date().toISOString().split('T')[0];

    // Scale the target article count to the source. Code repos have many
    // modules/classes/flows and warrant 20-40+ articles. A single file or URL
    // is usually one document — asking for 20-40 pages from it makes the
    // model invent filler and takes 5-15 minutes per ingest. For a doc-shaped
    // source, a handful of concept pages is enough.
    const isCode = srcType === 'repo';
    const targetRange = isCode ? '20-40' : '3-8';
    const articleTypesList = isCode
      ? [
          '- `modules/xxx.md` — one per major module, directory, service, or component',
          '- `concepts/xxx.md` — one per pattern, algorithm, architectural decision, or important idea',
          '- `entities/xxx.md` — one per data model, class, database table, or key type',
          '- `flows/xxx.md` — one per end-to-end flow showing function call chains',
        ].join('\n')
      : [
          '- `concepts/xxx.md` — one per distinct topic or idea the source introduces',
          '- `entities/xxx.md` — optional; only for named things (products, teams, systems) the source defines',
        ].join('\n');
    const codebaseWord = isCode ? 'codebase' : 'document';

    const modeInstruction = effectiveMode === 'first'
      ? `This is the FIRST source being ingested into an empty wiki. Create the initial wiki from this ${codebaseWord} — aim for ${targetRange} articles covering the distinct topics it contains. Don't pad; only create an article if there's real substance for it.`
      : effectiveMode === 'new-source'
      ? `This is a NEW source being added to an existing wiki. This is a DIFFERENT ${codebaseWord} from what's already there. Create articles for the distinct topics in this source — aim for ${targetRange} new articles, don't invent filler. Also update existing articles where this source adds relevant cross-references or shared concepts.`
      : `This source was previously ingested and is being RE-SYNCED. Check what changed and update affected articles. Add new articles for any new ${isCode ? 'code or concepts' : 'topics'}.`;

    const prompt = `You are maintaining a knowledge wiki following the Karpathy LLM Wiki pattern.

${modeInstruction}

CRITICAL: Return ONLY a JSON object. No text before or after.

## Existing wiki
${existingWiki}

## Source: ${srcName} (${srcType})

${content}

## Your task

1. Read the source thoroughly — ${isCode ? 'understand every module, class, function, pattern' : 'identify the distinct topics, named entities, and ideas it covers'}
2. ${effectiveMode === 'first'
  ? `Create the initial wiki: overview.md + ${isCode ? 'module pages + concept pages + entity pages + flow pages' : 'concept pages (plus entity pages only if the source introduces named things)'}. Aim for ${targetRange} articles — don't pad, only what the source actually warrants.`
  : effectiveMode === 'new-source'
  ? `Create articles for the distinct topics in this source — target ${targetRange} new articles. ${isCode ? 'Each major module, concept, entity, and flow deserves its own article.' : 'Focus on the concepts the source introduces.'} Do NOT skip things just because a similar topic exists from another source — this is a different ${codebaseWord}. Also update existing articles where this source adds new information.`
  : `Check what changed vs existing wiki. Update affected articles. Add new articles for new ${isCode ? 'code/concepts' : 'topics'}.`}
3. ${effectiveMode === 'first' ? 'Create' : 'Update'} index.md — full catalog of ALL articles
4. Write a log entry

## Article types — create ALL that apply
${articleTypesList}

## Rules
- Cross-reference between articles: \`[Name](entities/name.md)\`
- "See also" section at bottom of each page
- Source attribution: \`Source: ${srcName}\` (articles can have multiple sources)
- For code: actual function names, class names, file paths, signatures
- For flows: \`funcA() → funcB() → funcC()\` with links
- Every article: 200+ words, real substance
${effectiveMode !== 'first' ? `- When this source mentions entities/concepts that already have wiki pages, UPDATE those pages to add info from this source
- Preserve existing content in updated pages — add to it, don't replace
- Do NOT skip creating new articles just because similar concepts exist — each source deserves thorough coverage` : ''}

## Return format

{
  ${effectiveMode !== 'first' ? '"updated": [\n    { "path": "entities/product.md", "title": "Product", "content": "full updated page content with info from both sources" }\n  ],' : ''}
  "created": [
    { "path": "modules/xxx.md", "title": "Module Name", "content": "# Module Name\\n\\n..." }
  ],
  ${effectiveMode === 'first' ? '"overview": "# System Overview\\n\\n...",' : ''}
  "index": "# Wiki Index\\n\\n- [Overview](overview.md) — ...\\n...",
  "logEntry": "## [${now}] ${effectiveMode === 'sync' ? 'sync' : 'ingest'} | ${srcName}\\n- ..."
}`;

    let lastProgressUpdate = 0;
    const response = await this.callClaudeWithRetry(prompt, (chars) => {
      // Update progress every 5k chars to avoid DB hammering
      if (chars - lastProgressUpdate > 5000) {
        lastProgressUpdate = chars;
        const kChars = Math.round(chars / 1000);
        updateStatus(`Claude generating wiki for ${srcName}... (${kChars}k chars)`).catch(() => {});
      }
    });
    const parsed = this.parseWikiJson(response);

    if (!parsed) throw new Error('Could not parse Claude response');

    // 4. Write results
    await updateStatus(`Writing wiki articles...`);
    let createdCount = 0;
    let updatedCount = 0;

    // Write created articles
    if (parsed.created) {
      for (const article of parsed.created) {
        const articlePath = path.join(wikiDir, article.path);
        fs.mkdirSync(path.dirname(articlePath), { recursive: true });
        fs.writeFileSync(articlePath, article.content, 'utf-8');
        createdCount++;
      }
    }

    // Write updated articles
    if (parsed.updated) {
      for (const article of parsed.updated) {
        const articlePath = path.join(wikiDir, article.path);
        fs.mkdirSync(path.dirname(articlePath), { recursive: true });
        fs.writeFileSync(articlePath, article.content, 'utf-8');
        updatedCount++;
      }
    }

    // Write overview (first ingest only)
    if (parsed.overview) {
      fs.writeFileSync(path.join(wikiDir, 'overview.md'), parsed.overview, 'utf-8');
    }

    // Write/update index.md
    if (parsed.index) {
      fs.writeFileSync(path.join(wikiDir, 'index.md'), parsed.index, 'utf-8');
    }

    // Update manifest — track which source created/updated which articles
    const createdPaths = (parsed.created ?? []).map((a: any) => a.path);
    const updatedPaths = (parsed.updated ?? []).map((a: any) => a.path);
    manifest[srcName] = {
      created: [...new Set([...(manifest[srcName]?.created ?? []), ...createdPaths])],
      updated: [...new Set([...(manifest[srcName]?.updated ?? []), ...updatedPaths])],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Append to log.md (never overwrite)
    if (parsed.logEntry) {
      const logPath = path.join(wikiDir, 'log.md');
      const existingLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '# Wiki Log\n';
      fs.writeFileSync(logPath, existingLog + '\n' + parsed.logEntry + '\n', 'utf-8');
    }

    // 5. Update source status
    await getDb().query(
      "UPDATE knowledge_sources SET status = 'compiled', last_synced = datetime('now') WHERE id = $1",
      [sourceId]
    );

    logger.info('Source ingested', { source: srcName, mode, created: createdCount, updated: updatedCount });

    // Reload agent to pick up knowledge in CLAUDE.md
    await this.reloadAgent(agentId);

    return { created: createdCount, updated: updatedCount };
  }

  /**
   * Ingest a single source (triggered by adding a source or clicking Ingest).
   */
  private async ingestSingleSource(agentId: string, sourceId: string, requestId: string): Promise<void> {
    try {
      const result = await this.ingestSource(agentId, sourceId, requestId, 'sync');
      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'done',
        articles: result.created + result.updated,
        created: result.created,
        updated: result.updated,
        summary: `Ingested: ${result.created} new, ${result.updated} updated`,
      }));
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logger.error('Ingest failed', { agentId, sourceId, requestId, error: msg });
      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'error',
        error: msg.includes('AUTH_NEEDS_LOGIN') ? 'Run `claude login` in your terminal.' : msg === 'Source not found' ? 'Source was deleted before the build could complete.' : `Ingest failed: ${msg.slice(0, 200)}`,
      }));
    }
  }

  /**
   * Build Wiki — ingests only sources not yet compiled (status != 'compiled').
   * Each source is processed one by one, wiki compounds incrementally.
   */
  private async buildKnowledgeWiki(agentId: string, requestId: string): Promise<void> {
    logger.info('Building knowledge wiki', { agentId, requestId });

    try {
      const agent = await getAgentById(agentId);
      if (!agent) { await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'error', error: 'Agent not found' })); return; }

      const { getDb } = await import('@slackhive/shared');
      const fs = await import('fs');
      const path = await import('path');
      const { getAgentWorkDir } = await import('./compile-claude-md');

      // Sync check: if wiki is empty/missing but DB says sources are compiled, reset all
      const wikiDir = path.join(getAgentWorkDir(agent.slug), 'knowledge', 'wiki');
      let wikiHasArticles = false;
      try {
        if (fs.existsSync(wikiDir)) {
          const walk = (dir: string): boolean => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.isFile() && e.name.endsWith('.md')) return true;
              if (e.isDirectory() && walk(path.join(dir, e.name))) return true;
            }
            return false;
          };
          wikiHasArticles = walk(wikiDir);
        }
      } catch { /* ok */ }

      if (!wikiHasArticles) {
        // Wiki is gone — reset all compiled sources to pending for full rebuild
        await getDb().query(
          "UPDATE knowledge_sources SET status = 'pending' WHERE agent_id = $1 AND status = 'compiled'",
          [agentId]
        );
        logger.info('Wiki empty — reset all sources to pending', { agentId });
      }

      // Check total vs pending sources
      const allR = await getDb().query('SELECT count(*) as cnt FROM knowledge_sources WHERE agent_id = $1', [agentId]);
      const totalCount = parseInt(allR.rows[0]?.cnt as string ?? '0', 10);
      const pendingR = await getDb().query(
        "SELECT * FROM knowledge_sources WHERE agent_id = $1 AND status != 'compiled' ORDER BY created_at ASC",
        [agentId]
      );
      const pendingSources = pendingR.rows;

      if (pendingSources.length === 0) {
        await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'done', articles: 0, message: 'All sources already compiled.' }));
        return;
      }

      const startedAt = Date.now();

      // Smart mode: if ALL sources are pending (e.g. after a delete), clear wiki first for clean rebuild
      const isFullRebuild = pendingSources.length === totalCount;
      if (isFullRebuild) {
        await setResult(`knowledge-build:${requestId}`, JSON.stringify({ status: 'building', startedAt, step: 'Clearing wiki for rebuild...' }));
        const wikiDir = path.join(getAgentWorkDir(agent.slug), 'knowledge', 'wiki');
        try { fs.rmSync(wikiDir, { recursive: true, force: true }); } catch { /* ok */ }
      }

      let totalCreated = 0;
      let totalUpdated = 0;

      for (let i = 0; i < pendingSources.length; i++) {
        const src = pendingSources[i];

        // Check source still exists before starting — abort if it was deleted mid-build
        const stillExists = await getDb().query('SELECT id FROM knowledge_sources WHERE id = $1', [src.id]);
        if (stillExists.rows.length === 0) {
          logger.info('Source deleted during build — stopping', { source: src.name, agentId });
          await setResult(`knowledge-build:${requestId}`, JSON.stringify({
            status: 'error',
            error: `Source "${src.name}" was deleted while the wiki was building.`,
          }));
          return;
        }

        await setResult(`knowledge-build:${requestId}`, JSON.stringify({
          status: 'building', startedAt: Date.now(),
          step: `${isFullRebuild ? 'Rebuilding' : 'Ingesting'} ${src.name} (${i + 1}/${pendingSources.length})...`,
        }));

        try {
          const result = await this.ingestSource(agentId, src.id as string, requestId, 'ingest');
          totalCreated += result.created;
          totalUpdated += result.updated;
        } catch (err) {
          logger.warn('Source ingest failed', { source: src.name, error: (err as Error).message });
        }
      }

      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'done',
        articles: totalCreated + totalUpdated,
        created: totalCreated,
        updated: totalUpdated,
        summary: `Ingested ${pendingSources.length} source(s): ${totalCreated} created, ${totalUpdated} updated`,
      }));

      logger.info('Knowledge wiki built', { agentId, sources: pendingSources.length, created: totalCreated, updated: totalUpdated });

    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logger.error('Knowledge build failed', { agentId, requestId, error: msg });
      await setResult(`knowledge-build:${requestId}`, JSON.stringify({
        status: 'error',
        error: msg.includes('AUTH_NEEDS_LOGIN') ? 'Run `claude login` in your terminal.' : `Build failed: ${msg.slice(0, 200)}`,
      }));
    }
  }

  private async buildWikiFolderSources(
    folderId: string,
    requestId: string,
    scratch: boolean,
    singleSourceId?: string,
  ): Promise<void> {
    logger.info('Building wiki folder sources', { folderId, requestId, scratch, singleSourceId });
    const wikiDir = path.join(os.homedir(), '.slackhive', 'knowledge', folderId, 'wiki');

    const buildStartedAt = new Date().toISOString();
    const writeProgress = async (data: Record<string, unknown>) => {
      await setResult(`wiki-build:${requestId}`, JSON.stringify({ buildStartedAt, ...data }));
    };

    // Issue 5: sanitize PAT tokens from error messages before storing/logging
    const sanitizeError = (msg: string) =>
      msg.replace(/https?:\/\/[^@\s]+@/g, 'https://**REDACTED**@');

    // Lock lives one level above wikiDir so scratch rmSync(wikiDir) doesn't destroy it
    const folderDir = path.join(os.homedir(), '.slackhive', 'knowledge', folderId);
    fs.mkdirSync(wikiDir, { recursive: true });
    const lockPath = path.join(folderDir, '.build.lock');
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: buildStartedAt, requestId }), { flag: 'wx' });
    } catch {
      let lockInfo: Record<string, unknown> = {};
      try { lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch { /* lock file may be gone already */ }
      logger.warn('Wiki build already in progress, skipping', { folderId, lockInfo });
      await writeProgress({ status: 'error', folderId, error: 'Build already in progress — try again shortly.' });
      return;
    }

    try {
      await writeProgress({ status: 'building', folderId, step: 'Starting...' });

      // Hoist single getDb import used throughout this function
      const { getDb } = await import('@slackhive/shared');

      if (scratch) {
        await writeProgress({ status: 'building', folderId, step: 'Clearing wiki for rebuild...' });
        try { fs.rmSync(wikiDir, { recursive: true, force: true }); } catch { /* ok */ }
        fs.mkdirSync(wikiDir, { recursive: true });
        // Lock is at folderDir level (above wikiDir) so rmSync above doesn't touch it
        // Reset every source in the folder back to a clean pending state:
        // status, word_count, and last_synced. Without zeroing word_count and
        // last_synced the UI keeps showing stale figures (e.g. "5,124 words ·
        // synced 2d ago") even though the wiki on disk just got wiped.
        await getDb().query(
          "UPDATE wiki_sources SET status = 'pending', word_count = 0, last_synced = NULL WHERE folder_id = $1",
          [folderId],
        );
      }

      // Query sources with status directly
      let pendingSources: Array<{ id: string; name: string; type: string; content: string | null; url: string | null; repoUrl: string | null; branch: string; patEnvRef: string | null; status: string; lastSyncedSha: string | null }>;
      if (singleSourceId != null) {
        const r = await getDb().query(
          'SELECT id, name, type, content, url, repo_url, branch, pat_env_ref, status, last_synced_sha FROM wiki_sources WHERE id = $1 AND folder_id = $2',
          [singleSourceId, folderId],
        );
        pendingSources = r.rows.map((row: any) => ({
          id: row.id, name: row.name, type: row.type, content: row.content ?? null,
          url: row.url ?? null, repoUrl: row.repo_url ?? null, branch: row.branch ?? 'main',
          patEnvRef: row.pat_env_ref ?? null, status: row.status,
          lastSyncedSha: row.last_synced_sha ?? null,
        }));
      } else {
        const r = await getDb().query(
          "SELECT id, name, type, content, url, repo_url, branch, pat_env_ref, status, last_synced_sha FROM wiki_sources WHERE folder_id = $1 AND status IN ('pending', 'stale', 'error') ORDER BY created_at ASC",
          [folderId],
        );
        pendingSources = r.rows.map((row: any) => ({
          id: row.id, name: row.name, type: row.type, content: row.content ?? null,
          url: row.url ?? null, repoUrl: row.repo_url ?? null, branch: row.branch ?? 'main',
          patEnvRef: row.pat_env_ref ?? null, status: row.status,
          lastSyncedSha: row.last_synced_sha ?? null,
        }));
      }

      if (pendingSources.length === 0) {
        await writeProgress({ status: 'done', folderId, pages: 0, words: 0, message: 'Nothing to build.' });
        return;
      }

      // Read existing wiki — returns index.md or article path list to keep prompt small
      const readExistingWiki = (): string => {
        if (!fs.existsSync(wikiDir)) return '(empty — no wiki yet)';
        const indexPath = path.join(wikiDir, 'index.md');
        if (fs.existsSync(indexPath)) return fs.readFileSync(indexPath, 'utf-8');
        const paths: string[] = [];
        const walk = (dir: string, rel: string) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) { walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); continue; }
            if (!e.name.endsWith('.md') || e.name === 'log.md') continue;
            paths.push(`${rel ? `${rel}/` : ''}${e.name}`);
          }
        };
        walk(wikiDir, '');
        return paths.length ? `Existing articles:\n${paths.join('\n')}` : '(empty — no wiki yet)';
      };

      // Read the current overview.md so Claude can extend it in-place rather
      // than regenerating from scratch each source. Returns '' when missing.
      const readExistingOverview = (): string => {
        const overviewPath = path.join(wikiDir, 'overview.md');
        try { return fs.existsSync(overviewPath) ? fs.readFileSync(overviewPath, 'utf-8') : ''; }
        catch { return ''; }
      };

      const manifestPath = path.join(wikiDir, 'manifest.json');
      let manifest: Record<string, { created: string[]; updated: string[] }> = {};
      try { if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch { /* ok */ }

      let totalPages = 0;
      let totalWords = 0;
      // Issue 1: accumulate all articles across all chunks and sources to build index once at end
      const allIndexEntries: { path: string; title: string }[] = [];
      // Pre-populate index entries from sources not being rebuilt this run
      for (const [srcName, srcManifest] of Object.entries(manifest)) {
        if (!pendingSources.find(s => s.name === srcName)) {
          for (const p of [...(srcManifest.created ?? []), ...(srcManifest.updated ?? [])]) {
            allIndexEntries.push({ path: p, title: path.basename(p, '.md').replace(/-/g, ' ') });
          }
        }
      }

      // Issue 7: cross-repo context block when folder has multiple sources
      const siblingBlock = pendingSources.length > 1
        ? `\n\n## Sibling sources in this wiki folder\nThis folder contains ${pendingSources.length} sources: ${pendingSources.map(s => `"${s.name}"`).join(', ')}. You are currently building for the source named below. Where relevant, note cross-service dependencies between sources.\n`
        : '';

      for (let i = 0; i < pendingSources.length; i++) {
        const src = pendingSources[i];
        // Issue 2: namespace all article paths by source slug to prevent cross-source collisions
        const sourceSlug = src.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        let sourceWords = 0; // per-source word count, separate from running total
        await updateWikiSourceStatus(src.id, 'building');
        await writeProgress({
          status: 'building', folderId,
          step: `Processing ${src.name}…`,
          sourceName: src.name, sourceIdx: i, sourcesTotal: pendingSources.length,
          articlesWritten: totalPages,
        });

        try {
          let content = '';
          // Set by the repo branch below; consumed when persisting last_synced_sha
          // after a successful compile and when building the diff-mode prompt.
          let sourceCurrentSha: string | null = null;
          let sourceDiff: RepoDiff | null = null;
          if (src.type === 'file' || src.type === 'url') {
            content = src.content ?? '';
            if (!content && src.url) {
              await writeProgress({ status: 'building', folderId, step: `Fetching ${src.name}…`, sourceName: src.name, sourceIdx: i, sourcesTotal: pendingSources.length, articlesWritten: totalPages });
              const resp = await fetch(src.url);
              if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${src.url}`);
              content = await resp.text();
              // Save fetched content back to DB
              await getDb().query('UPDATE wiki_sources SET content = $1 WHERE id = $2', [content, src.id]);
            }
            if (!content) throw new Error(`Source "${src.name}" has no content`);
          } else if (src.type === 'repo') {
            await writeProgress({ status: 'building', folderId, step: `Cloning ${src.name}…`, sourceName: src.name, sourceIdx: i, sourcesTotal: pendingSources.length, articlesWritten: totalPages });
            // Pass src.id so each clone gets its own /tmp/slackhive-repo-<uuid>
            // dir. Without this every repo clones into /tmp/slackhive-repo-undefined,
            // which collides with any leftover dir from a SIGTERM-killed previous
            // build and breaks the FIRST source's clone on every fresh restart.
            // Pass src.lastSyncedSha so readRepoContent can return a diff-focused
            // content slice on incremental re-syncs.
            const repoResult = await this.readRepoContent({
              id: src.id, repo_url: src.repoUrl, branch: src.branch, pat_env_ref: src.patEnvRef, name: src.name,
            } as any, src.lastSyncedSha);
            content = repoResult.content;
            sourceCurrentSha = repoResult.currentSha;
            sourceDiff = repoResult.diff;

            // Short-circuit: HEAD hasn't moved since last sync. Skip Claude
            // entirely, refresh last_synced timestamp, and move on. Massive
            // win on no-op rebuilds — zero token spend.
            if (
              src.lastSyncedSha &&
              sourceCurrentSha &&
              src.lastSyncedSha === sourceCurrentSha &&
              src.status === 'compiled'
            ) {
              logger.info('[wiki] Repo unchanged since last sync — skipping', {
                source: src.name, sha: sourceCurrentSha.slice(0, 7),
              });
              await getDb().query(
                'UPDATE wiki_sources SET last_synced = $1 WHERE id = $2',
                [new Date().toISOString(), src.id],
              );
              continue; // jump to next source in the for loop
            }
          }

          const existingWiki = readExistingWiki();
          const wikiIsEmpty = existingWiki === '(empty — no wiki yet)';
          const sourceEverIngested = !!manifest[src.name];
          const isCode = src.type === 'repo';
          const targetRange = isCode ? '20-40' : '3-8';
          const effectiveMode = wikiIsEmpty ? 'first' : (sourceEverIngested && src.status === 'stale') ? 'sync' : 'new-source';

          // Issue 3: for stale re-sync, delete old files for this source before re-ingesting
          if (effectiveMode === 'sync' && manifest[src.name]) {
            const prevPaths = [...(manifest[src.name].created ?? []), ...(manifest[src.name].updated ?? [])];
            for (const p of prevPaths) {
              // Validate path stays within the source slug directory to prevent traversal
              if (!p.startsWith(`${sourceSlug}/`) || p.includes('..')) {
                logger.warn('[wiki] Skipping manifest path outside source slug', { path: p, sourceSlug });
                continue;
              }
              const full = path.join(wikiDir, p);
              try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch { /* ok */ }
            }
            delete manifest[src.name];
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
          }

          // Issue 6: expanded article types — architecture, guides, api, infra for repos
          const articleTypesList = isCode
            ? [
                `- \`${sourceSlug}/architecture/overview.md\` — high-level design, component map, tech stack`,
                `- \`${sourceSlug}/architecture/data-flow.md\` — data flow between services/layers`,
                `- \`${sourceSlug}/guides/onboarding.md\` — setup, first run, how to make first contribution`,
                `- \`${sourceSlug}/guides/deprecated.md\` — deprecated APIs, patterns to avoid and why`,
                `- \`${sourceSlug}/api/contracts.md\` — public API surface, endpoints, request/response shapes`,
                `- \`${sourceSlug}/api/events.md\` — events, webhooks, message queues emitted/consumed`,
                `- \`${sourceSlug}/infra/deployment.md\` — deploy process, environments, CI/CD pipeline`,
                `- \`${sourceSlug}/infra/config.md\` — env vars, feature flags, required secrets`,
                `- \`${sourceSlug}/modules/{name}.md\` — per-module/package breakdown`,
                `- \`${sourceSlug}/concepts/{name}.md\` — domain concepts, business logic`,
                `- \`${sourceSlug}/entities/{name}.md\` — data models, schemas`,
                `- \`${sourceSlug}/flows/{name}.md\` — user or system flows`,
              ].join('\n')
            : [
                `- \`${sourceSlug}/concepts/{name}.md\``,
                `- \`${sourceSlug}/entities/{name}.md\` (optional)`,
              ].join('\n');

          const modeInstruction = effectiveMode === 'first'
            ? `This is the FIRST source. Create the initial wiki — aim for ${targetRange} articles. Don't pad.`
            : effectiveMode === 'new-source'
            ? `This is a NEW source being added to an existing wiki. Create articles for distinct topics — aim for ${targetRange}. Also update existing articles where relevant.`
            : `This source was previously ingested and is being RE-SYNCED. Update affected articles. Add new articles for new content.`;
          const now = new Date().toISOString().split('T')[0];

          // Split large content into chunks so each Claude call stays within context limits.
          const CHUNK_SIZE = 100_000;
          const chunks: string[] = [];
          for (let off = 0; off < content.length; off += CHUNK_SIZE) chunks.push(content.slice(off, off + CHUNK_SIZE));

          // When we have a diff (incremental sync), tell Claude that the
          // source content is ONLY changed files, that any prior articles
          // about untouched files should be left alone, and that articles
          // for deleted/renamed files should be removed via the new
          // `removed` field. This replaces the standard mode instruction
          // for the first chunk only — subsequent chunks (rare in diff
          // mode since diffs are small) keep the part-N message.
          const incrementalInstruction = sourceDiff
            ? `This is an INCREMENTAL re-sync of source "${src.name}". The content below is ONLY the files that changed since the last sync (added / modified / renamed) — NOT the whole repo. Articles about files that didn't change must be LEFT ALONE; do not regenerate or rewrite them. For each changed file: update the article that describes it (or create one if it's new). For deleted files (paths listed but no body), include the affected article paths in the new "removed" field so they're cleaned up.`
            : null;

          for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
            const chunkContent = chunks[chunkIdx];
            const chunkLabel = chunks.length > 1 ? ` (part ${chunkIdx + 1}/${chunks.length})` : '';
            const chunkModeInstruction = chunkIdx === 0
              ? (incrementalInstruction ?? modeInstruction)
              : `This is PART ${chunkIdx + 1} of ${chunks.length} of source "${src.name}". Articles from earlier parts are already in the wiki. Add new articles for topics in this part not yet covered. Update existing articles where this part adds relevant info.`;
            const chunkStartedAt = new Date().toISOString();
            await writeProgress({
              status: 'building', folderId,
              step: `Generating wiki for ${src.name}${chunkLabel}…`,
              sourceName: src.name, sourceIdx: i, sourcesTotal: pendingSources.length,
              chunkIdx, chunksTotal: chunks.length, chunkStartedAt,
              articlesWritten: totalPages,
            });
            const currentWiki = readExistingWiki();
            const currentOverview = readExistingOverview();

            // Overview policy: refresh overview.md on the FIRST chunk of
            // EVERY source so it grows to reflect the whole wiki, not just
            // source #1. Multi-chunk single sources still only generate
            // overview once (chunkIdx === 0), so cost stays bounded.
            //
            // Tell Claude the full set of sources that contribute to this
            // wiki — past (from manifest) + current — so the overview can
            // be a true high-level synthesis across all of them, not just
            // a description of the source being ingested right now.
            //
            // Cap the existing overview at 4KB before injection so a runaway
            // prior overview can't push the prompt over Claude's context
            // limit when combined with a 100KB source chunk and large index.
            const wantsOverview = chunkIdx === 0;
            const MAX_OVERVIEW_PROMPT_BYTES = 4_000;
            const overviewForPrompt = currentOverview.length > MAX_OVERVIEW_PROMPT_BYTES
              ? currentOverview.slice(0, MAX_OVERVIEW_PROMPT_BYTES) + '\n…[truncated for prompt budget]'
              : currentOverview;
            const allSourceNames = [...new Set([...Object.keys(manifest), src.name])].sort();
            const sourceListLine = `All sources in this wiki: ${allSourceNames.join(', ')}`;
            const overviewInstruction = !wantsOverview ? '' : (overviewForPrompt
              ? `\n\n## Overview update\noverview.md is the high-level intro to the ENTIRE wiki — it must summarize what every source contributes, not just this one. Extend the existing overview below to incorporate "${src.name}" alongside the coverage already there. Preserve structure; extend rather than replace. Keep it 3–5 paragraphs total.\n\n${sourceListLine}\n\nExisting overview:\n\n${overviewForPrompt}`
              : `\n\n## Overview\nCreate overview.md — a brief 3–5 paragraph intro describing what this wiki covers across ALL sources at a high level. Lead with the highest-level domain, then summarize the major areas.\n\n${sourceListLine}`);
            const overviewField = wantsOverview ? '\n  "overview": "# Overview\\n...",' : '';
            // In diff mode, advertise the `removed` field so Claude can
            // signal articles to delete (deleted/renamed source files).
            // Snapshot mode never uses this — leave the field out so we
            // don't accidentally invite spurious removals on first ingest.
            const removedField = sourceDiff ? '\n  "removed": ["' + sourceSlug + '/path/to/article-to-delete.md"],' : '';

            const prompt = `You are maintaining a knowledge wiki following the Karpathy LLM Wiki pattern.\n\n${chunkModeInstruction}\n\nCRITICAL: Return ONLY a JSON object. No text before or after.\n\nIMPORTANT: All file paths MUST be prefixed with \`${sourceSlug}/\`. Example: \`${sourceSlug}/concepts/auth.md\`. Never write a path without this prefix.${siblingBlock}\n\n## Existing wiki\n${currentWiki}${overviewInstruction}\n\n## Source: ${src.name} (${src.type})${chunkLabel}\n\n${chunkContent}\n\n## Article types\n${articleTypesList}\n\n## Rules\n- Cross-reference between articles\n- Every article: 200+ words, real substance\n- Preserve existing content in updated pages — add to it, do not replace\n\n## Return format\n\n{\n  "updated": [{ "path": "${sourceSlug}/entities/x.md", "title": "X", "content": "..." }],\n  "created": [{ "path": "${sourceSlug}/concepts/x.md", "title": "X", "content": "..." }],${removedField}${overviewField}\n  "logEntry": "## [${now}] ingest | ${src.name}${chunkLabel}\\n- ..."\n}`;

            let lastProgress = 0;
            const response = await this.callClaudeWithRetry(prompt, (chars) => {
              if (chars - lastProgress > 5000) {
                lastProgress = chars;
                writeProgress({
                  status: 'building', folderId,
                  step: `Claude writing articles for ${src.name}${chunkLabel}… (${Math.round(chars / 1000)}k chars)`,
                  sourceName: src.name, sourceIdx: i, sourcesTotal: pendingSources.length,
                  chunkIdx, chunksTotal: chunks.length, chunkStartedAt,
                  articlesWritten: totalPages,
                }).catch(() => {});
              }
            });

            const parsed = this.parseWikiJson(response);
            if (!parsed) {
              // Diagnostic: log a head + tail snippet of the unparseable
              // response so we can tell whether Claude returned prose, a
              // refusal, was truncated mid-JSON, or hit a token cap. Without
              // this the only signal was the bare error message and we'd
              // have to add logging + re-trigger the build to learn anything.
              const head = response.slice(0, 500);
              const tail = response.length > 1000 ? response.slice(-500) : '';
              logger.error('[wiki] Could not parse Claude response', {
                folderId, source: src.name, chunkIdx,
                responseLength: response.length,
                responseHead: head,
                responseTail: tail,
              });
              throw new Error(`Could not parse Claude response for chunk ${chunkIdx + 1} (response was ${response.length} chars; check log for head/tail)`);
            }

            // Issue 9: warn if chunk produced no articles
            const chunkArticleCount = (parsed.created?.length ?? 0) + (parsed.updated?.length ?? 0);
            if (chunkArticleCount === 0) {
              logger.warn('[wiki] Chunk produced 0 articles', { folderId, source: src.name, chunkIdx });
            }

            for (const article of (parsed.created ?? [])) {
              const articlePath = article.path.startsWith(`${sourceSlug}/`) ? article.path : `${sourceSlug}/${article.path}`;
              const p = path.resolve(wikiDir, articlePath);
              if (!p.startsWith(wikiDir + path.sep)) { logger.warn('[wiki] Skipping article path outside wikiDir', { path: articlePath }); continue; }
              fs.mkdirSync(path.dirname(p), { recursive: true });
              fs.writeFileSync(p, article.content, 'utf-8');
              totalPages++;
              const wc = article.content.split(/\s+/).filter(Boolean).length;
              totalWords += wc;
              sourceWords += wc;
              allIndexEntries.push({ path: articlePath, title: article.title ?? path.basename(articlePath, '.md') });
            }
            for (const article of (parsed.updated ?? [])) {
              const articlePath = article.path.startsWith(`${sourceSlug}/`) ? article.path : `${sourceSlug}/${article.path}`;
              const p = path.resolve(wikiDir, articlePath);
              if (!p.startsWith(wikiDir + path.sep)) { logger.warn('[wiki] Skipping article path outside wikiDir', { path: articlePath }); continue; }
              fs.mkdirSync(path.dirname(p), { recursive: true });
              fs.writeFileSync(p, article.content, 'utf-8');
              const wc = article.content.split(/\s+/).filter(Boolean).length;
              totalWords += wc;
              sourceWords += wc;
              allIndexEntries.push({ path: articlePath, title: article.title ?? path.basename(articlePath, '.md') });
            }
            // Diff-mode-only `removed` field — Claude is told to list articles
            // tied to deleted/renamed source files. Extracted to a free
            // function so it's independently testable (path-traversal
            // protection + manifest trimming).
            if (Array.isArray(parsed.removed)) {
              processRemovedArticles(wikiDir, sourceSlug, src.name, parsed.removed, manifest as SourceManifest, logger);
            }
            // Sanity-check the returned overview before persisting: must be
            // a non-trivial string (>= 50 chars). Guards against empty or
            // pathologically short returns silently overwriting a
            // perfectly-good prior overview.
            if (chunkIdx === 0 && typeof parsed.overview === 'string' && parsed.overview.trim().length >= 50) {
              fs.writeFileSync(path.join(wikiDir, 'overview.md'), parsed.overview, 'utf-8');
            } else if (chunkIdx === 0 && parsed.overview) {
              logger.warn('[wiki] Skipping overview write — return too short', {
                folderId, source: src.name, length: String(parsed.overview).length,
              });
            }
            // Issue 1: do NOT write index.md here — we write it once after all sources finish
            if (parsed.logEntry) {
              const logPath = path.join(wikiDir, 'log.md');
              const existingLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '# Wiki Log\n';
              fs.writeFileSync(logPath, existingLog + '\n' + parsed.logEntry + '\n', 'utf-8');
            }
            const createdPaths = (parsed.created ?? []).map((a: any) =>
              a.path.startsWith(`${sourceSlug}/`) ? a.path : `${sourceSlug}/${a.path}`);
            const updatedPaths = (parsed.updated ?? []).map((a: any) =>
              a.path.startsWith(`${sourceSlug}/`) ? a.path : `${sourceSlug}/${a.path}`);
            manifest[src.name] = {
              created: [...new Set([...(manifest[src.name]?.created ?? []), ...createdPaths])],
              updated: [...new Set([...(manifest[src.name]?.updated ?? []), ...updatedPaths])],
            };
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
          } // end chunk loop

          await updateWikiSourceStatus(src.id, 'compiled', sourceWords, new Date().toISOString());
          // Persist HEAD SHA so the next sync can compute a diff against it.
          // Skipped if rev-parse failed (sourceCurrentSha empty) — better to
          // re-do a full snapshot next time than to write a wrong SHA.
          if (sourceCurrentSha) {
            await getDb().query(
              'UPDATE wiki_sources SET last_synced_sha = $1 WHERE id = $2',
              [sourceCurrentSha, src.id],
            );
          }
          logger.info('Wiki source compiled', {
            folderId, source: src.name,
            sha: sourceCurrentSha ? sourceCurrentSha.slice(0, 7) : null,
            mode: sourceDiff ? 'incremental' : 'snapshot',
          });
        } catch (err) {
          const msg = sanitizeError((err as Error).message ?? String(err));
          logger.error('Wiki source build failed', { folderId, source: src.name, error: msg });
          await updateWikiSourceStatus(src.id, 'error');
        }
      }

      // Issue 1: write index.md once after all sources, grouping by top-level directory (source slug)
      if (allIndexEntries.length > 0) {
        const byGroup: Record<string, { path: string; title: string }[]> = {};
        for (const entry of allIndexEntries) {
          const group = entry.path.split('/')[0] || 'misc';
          (byGroup[group] ??= []).push(entry);
        }
        const indexLines = ['# Wiki Index\n'];
        for (const [group, entries] of Object.entries(byGroup).sort()) {
          indexLines.push(`\n## ${group}\n`);
          for (const e of entries) {
            indexLines.push(`- [${e.title}](${e.path})`);
          }
        }
        fs.writeFileSync(path.join(wikiDir, 'index.md'), indexLines.join('\n') + '\n', 'utf-8');
      }

      await writeProgress({ status: 'done', folderId, pages: totalPages, words: totalWords });
      logger.info('Wiki folder build complete', { folderId, pages: totalPages, words: totalWords });
    } catch (err) {
      const msg = sanitizeError((err as Error).message ?? String(err));
      logger.error('Wiki folder build error', { folderId, requestId, error: msg });
      await writeProgress({ status: 'error', folderId, error: msg.slice(0, 200) });
    } finally {
      // Issue 4: always release the build lock
      try { fs.unlinkSync(lockPath); } catch { /* ok */ }
    }
  }

  /**
   * Summarize a single skill on demand: load it, call the summarizer with one
   * retry on transient failure, write the description back, and trigger a
   * lightweight reload so the new description appears in the agent's
   * compiled CLAUDE.md skills index. No-ops if the skill already has a
   * description (lets event re-deliveries be idempotent) or the agent isn't
   * running on this runner.
   */
  private async summarizeSkillIfNeeded(agentId: string, skillId: string): Promise<void> {
    const skill = await getSkillById(skillId);
    if (!skill) return;
    if (skill.description) return; // Already filled — nothing to do.
    if (!this.runningAgents.has(agentId)) return; // Not our agent on this runner.

    const description = await this.callSummarizerWithRetry(skill.filename, skill.content);
    if (!description) return;

    await updateSkillDescription(skillId, description);
    logger.info('Skill description filled', {
      agentId,
      skillId,
      filename: skill.filename,
      description,
    });

    // Recompile CLAUDE.md so the new line appears in the skills index. Reload
    // is safe (the running session resumes via cached session keys); it's
    // also what every other config-touching mutation triggers.
    await this.reloadAgent(agentId).catch((err) =>
      logger.warn('Reload after skill summarize failed', { agentId, error: (err as Error).message })
    );
  }

  /**
   * One retry with a short backoff. Sonnet 4.6 is reliable enough that more
   * aggressive retries would cost more than they save — the startup sweep
   * catches anything that stays unfilled.
   */
  private async callSummarizerWithRetry(filename: string, content: string): Promise<string | null> {
    const first = await summarizeSkill(filename, content);
    if (first) return first;
    await new Promise(r => setTimeout(r, 1_500));
    return await summarizeSkill(filename, content);
  }

  /**
   * Find every skill across the workspace whose description is still NULL
   * and queue it for summarization. Throttled to one in-flight call at a
   * time so a 50-skill backlog doesn't spike API usage.
   */
  private async sweepMissingSkillDescriptions(): Promise<void> {
    const missing = await getSkillsMissingDescription();
    if (missing.length === 0) return;
    logger.info('Sweeping skills missing description', { count: missing.length });

    let filled = 0;
    for (const skill of missing) {
      // Only summarize for agents this runner actually owns; another runner
      // may pick up the rest. The skill-saved event handler does the same check.
      if (!this.runningAgents.has(skill.agentId)) continue;
      try {
        const description = await this.callSummarizerWithRetry(skill.filename, skill.content);
        if (description) {
          await updateSkillDescription(skill.id, description);
          filled++;
        }
      } catch (err) {
        logger.warn('Sweep summarize failed', {
          skillId: skill.id,
          filename: skill.filename,
          error: (err as Error).message,
        });
      }
    }

    if (filled > 0) {
      logger.info('Skill description sweep complete', { filled, attempted: missing.length });
      // Reload all touched agents so their CLAUDE.md picks up the new descriptions.
      const touchedAgents = new Set(missing.map(s => s.agentId).filter(id => this.runningAgents.has(id)));
      for (const agentId of touchedAgents) {
        await this.reloadAgent(agentId).catch((err) =>
          logger.warn('Sweep reload failed', { agentId, error: (err as Error).message })
        );
      }
    }
  }

  private async analyzeMemories(agentId: string, requestId: string): Promise<void> {
    logger.info('Analyzing memories', { agentId, requestId });

    try {
      const agent = await getAgentById(agentId);
      if (!agent) {
        await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'error', error: 'Agent not found' }));
        return;
      }

      const [memories, skills] = await Promise.all([
        getAgentMemories(agentId),
        getAgentSkills(agentId),
      ]);

      if (memories.length === 0) {
        await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'done', suggestions: [] }));
        return;
      }

      const memoriesList = memories.map(m =>
        `- [${m.id}] **${m.type}**: ${m.name} — ${m.content.slice(0, 200)}`
      ).join('\n');

      const skillsList = skills.map(s => `- ${s.category}/${s.filename}`).join('\n');

      const prompt = `You are analyzing an AI agent's learned memories to suggest improvements.

CRITICAL: Your entire response must be a single JSON object. No text before or after. No markdown fences. Start with { end with }.

## Agent: ${agent.name}
${agent.description || ''}

## Current Skills
${skillsList || '(none)'}

## Current System Prompt
${agent.claudeMd || '(empty)'}

## Memories to analyze (${memories.length})
${memoriesList}

## For each memory, suggest ONE action:
- **move_to_skill**: Memory contains reusable knowledge that belongs in a skill file
- **update_prompt**: Memory contains a behavioral rule that should be in the system prompt
- **merge**: Memory overlaps with another memory and they should be combined
- **delete**: Memory is outdated, trivial, or redundant with existing skills/prompt
- **keep**: Memory is fine as-is

Return this JSON:
{
  "suggestions": [
    {
      "memoryId": "<id>",
      "action": "move_to_skill" | "update_prompt" | "merge" | "delete" | "keep",
      "reason": "<brief explanation>",
      "mergeWith": "<other memory id, only if action is merge>"
    }
  ]
}`;

      // Mark as running
      await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'running' }));

      const fullResponse = await this.callClaudeWithRetry(prompt);

      // Parse JSON from response
      let parsed: any = null;
      const strategies = [
        () => JSON.parse(fullResponse),
        () => { const m = fullResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/); return m ? JSON.parse(m[1]) : null; },
        () => { const s = fullResponse.indexOf('{'); const e = fullResponse.lastIndexOf('}'); return s >= 0 && e > s ? JSON.parse(fullResponse.slice(s, e + 1)) : null; },
      ];
      for (const strategy of strategies) {
        try { parsed = strategy(); if (parsed) break; } catch { /* try next */ }
      }
      if (!parsed) throw new Error('JSON_PARSE: Could not extract JSON from Claude response');

      await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'done', ...parsed }));
      logger.info('Memory analysis complete', { agentId, requestId, suggestions: parsed.suggestions?.length ?? 0 });

    } catch (err) {
      const message = (err as Error).message ?? String(err);
      logger.error('Memory analysis failed', { agentId, requestId, error: message });

      let userError = 'Memory analysis failed. ';
      if (message.includes('AUTH_NEEDS_LOGIN')) {
        userError = 'Run `claude login` in your terminal, then restart SlackHive.';
      } else if (message.includes('401') || message.includes('auth')) {
        userError += 'Claude not authenticated. Run `claude login` in your terminal.';
      } else if (message.includes('JSON')) {
        userError += 'Claude returned an unexpected format. Try again.';
      } else {
        userError += message;
      }

      await setResult(`analyze:${requestId}`, JSON.stringify({ status: 'error', error: userError }));
    }
  }

  /**
   * Handles MCP authentication requests.
   * The Claude SDK's query() API doesn't support interactive OAuth.
   * Returns instructions for the user to authenticate via terminal.
   */
  private async authenticateMcp(requestId: string, mcpUrl: string, mcpName: string): Promise<void> {
    logger.info('MCP auth requested', { requestId, mcpName, mcpUrl });

    const { getDb } = await import('@slackhive/shared');
    const db = getDb();
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`mcp_auth:${requestId}`, JSON.stringify({
        status: 'action_needed',
        mcpName,
        message: `Run this command in your terminal to authenticate ${mcpName}:`,
        command: `claude mcp add --transport http ${mcpName} ${mcpUrl}`,
        hint: 'After authenticating, the token is saved automatically. Then click "Add to Catalog" to use it in SlackHive.',
      })]
    );
  }

  private async callClaudeWithRetry(prompt: string, onProgress?: (chars: number) => void): Promise<string> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const os = await import('os');

    const runQuery = async (): Promise<string> => {
      let text = '';
      for await (const msg of query({
        prompt,
        options: { maxTurns: 1, tools: [], allowedTools: [], permissionMode: 'acceptEdits', cwd: os.tmpdir() },
      })) {
        if (msg.type === 'assistant') {
          const content: any[] = (msg as any).message?.content ?? [];
          for (const block of content) {
            if (block.type === 'text') {
              text += block.text;
              if (onProgress) onProgress(text.length);
            }
          }
        }
        if (msg.type === 'result') {
          const r = (msg as any).result as string | undefined;
          if (r?.includes('authentication_error') || r?.includes('Failed to authenticate')) throw new Error(r);
          if (r) text = r;
        }
      }
      return text;
    };

    // Attempt 1: direct call
    try {
      return await runQuery();
    } catch (err1) {
      const msg1 = (err1 as Error).message ?? '';
      if (!msg1.includes('401') && !msg1.includes('auth') && !msg1.includes('credentials')) throw err1;
      logger.warn('SDK auth failed, trying Keychain sync...', { error: msg1.slice(0, 100) });
    }

    // Attempt 2: sync from macOS Keychain, then retry
    try {
      const { execSync } = await import('child_process');
      const fs = await import('fs');
      const path = await import('path');
      const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (creds) {
        const credPath = path.join(process.env.HOME || '/tmp', '.claude', '.credentials.json');
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
        fs.writeFileSync(credPath, creds, { mode: 0o600 });
        logger.info('Synced fresh credentials from Keychain');
        return await runQuery();
      }
    } catch {
      logger.warn('Keychain sync failed or not on macOS, trying token refresh...');
    }

    // Attempt 3: refresh OAuth token, then retry
    try {
      const refreshed = await ClaudeHandler.refreshOAuthToken();
      if (refreshed) {
        logger.info('OAuth token refreshed');
        return await runQuery();
      }
    } catch {
      logger.warn('Token refresh failed');
    }

    // All retries exhausted
    throw new Error('AUTH_NEEDS_LOGIN');
  }
}
