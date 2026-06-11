/**
 * @fileoverview Shared, backend-agnostic cleanup for on-disk per-session working
 * directories. Both {@link ClaudeBackend} and {@link CodexBackend} keep a cwd per
 * thread under `${workDir}/sessions/{key}` and let the agent pull git clones into
 * it (e.g. `<sessionDir>/repos`). The DB-level stale-session cleanup only drops the
 * `sessions` row (~30 min idle) — it never touches disk, so those clones accumulate
 * indefinitely. This prunes the directories themselves once a session has been idle
 * past `maxAgeMs` (7 days), reclaiming the clone storage.
 *
 * Idleness is keyed off the session dir's **own** mtime, which {@link markSessionUsed}
 * bumps at the start of every turn. That makes "last opened" an explicit, reliable
 * signal — independent of where the agent wrote (deep inside `repos/<clone>/`) or of
 * symlinked shared dirs (`knowledge/`) whose target mtime has nothing to do with this
 * session — so we neither reap an actively-used clone nor keep an abandoned one forever.
 *
 * @module runner/backends/prune-session-dirs
 */

import fs from 'fs';
import path from 'path';

/** How long an on-disk session dir may sit idle before its clones are reclaimed. */
export const SESSION_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Sanitize a session key into its on-disk dir name. Both backends key session
 *  dirs this way; sharing it keeps the prune's protect-set and the cache-eviction
 *  name-matching exactly in step with how dirs are actually created. */
export function sessionDirName(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Stamp a session dir as used "now" so the prune's idle clock restarts. Called at
 *  the top of every turn — cheap (one syscall) and best-effort (a missing dir or a
 *  read-only FS must never break a turn). */
export function markSessionUsed(sessionDir: string): void {
  try {
    const now = new Date();
    fs.utimesSync(sessionDir, now, now);
  } catch {
    /* best-effort — the dir may not exist yet, or the FS may be read-only. */
  }
}

/**
 * Delete per-session working dirs under `sessionsDir` whose own mtime is older than
 * `maxAgeMs`, skipping any whose dir name is in `protect` (e.g. sessions the backend
 * still holds live in memory). Errors on individual entries are swallowed so one bad
 * dir can't abort the sweep.
 *
 * @param sessionsDir Absolute path to a backend's `sessions/` root.
 * @param maxAgeMs Idle threshold; entries newer than this are kept.
 * @param opts.now Epoch ms "now" (injectable for tests; defaults to `Date.now()`).
 * @param opts.protect Dir names ({@link sessionDirName}) to never reap.
 * @returns Count and dir names removed.
 */
export function pruneStaleSessionDirs(
  sessionsDir: string,
  maxAgeMs: number,
  opts: { now?: number; protect?: ReadonlySet<string> } = {},
): { removed: number; names: string[] } {
  const now = opts.now ?? Date.now();
  const protect = opts.protect ?? new Set<string>();
  const names: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return { removed: 0, names: [] }; // sessions dir not created yet — nothing to do.
  }

  const cutoff = now - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (protect.has(entry.name)) continue; // live session — never reap mid-use.
    const dir = path.join(sessionsDir, entry.name);
    try {
      // lstat the dir itself (never follow into a symlinked child) — its mtime is the
      // last-opened stamp markSessionUsed wrote.
      if (fs.lstatSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      names.push(entry.name);
    } catch {
      /* swallow — a locked/partial dir shouldn't stop the rest of the sweep. */
    }
  }
  return { removed: names.length, names };
}
