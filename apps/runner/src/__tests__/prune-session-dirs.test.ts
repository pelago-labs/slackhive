import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  pruneStaleSessionDirs,
  markSessionUsed,
  sessionDirName,
  SESSION_DIR_MAX_AGE_MS,
} from '../backends/prune-session-dirs';

// Deterministic clock so age math doesn't depend on wall time.
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;
const ageMs = (ms: number) => new Date(NOW - ms);

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-sessions-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Create `root/<name>/` and set its own mtime to `ageMs` ago. Children written
 *  first so the dir's mtime is stamped last (writes bump it). */
function mkSession(name: string, idleMs: number, children: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(children)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const t = ageMs(idleMs);
  fs.utimesSync(dir, t, t);
  return dir;
}

describe('sessionDirName', () => {
  // Fix #1/#5: cache eviction matches dirs by this exact name, so it must equal
  // how the backends sanitize session keys into dir names.
  it('sanitizes every non-[A-Za-z0-9_-] char to underscore', () => {
    expect(sessionDirName('U123-C456-1700000000.0001')).toBe('U123-C456-1700000000_0001');
    expect(sessionDirName('a/b\\c:d e')).toBe('a_b_c_d_e');
    expect(sessionDirName('plain_key-1')).toBe('plain_key-1');
  });
});

describe('pruneStaleSessionDirs — core idle reaping', () => {
  it('removes dirs idle past maxAge and keeps fresh ones', () => {
    mkSession('stale', 10 * DAY);
    mkSession('fresh', 1 * DAY);
    const res = pruneStaleSessionDirs(root, SESSION_DIR_MAX_AGE_MS, { now: NOW });
    expect(res.removed).toBe(1);
    expect(res.names).toEqual(['stale']);
    expect(fs.existsSync(path.join(root, 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'fresh'))).toBe(true);
  });

  it('treats a dir exactly at the cutoff as still active (>= is kept)', () => {
    mkSession('edge', SESSION_DIR_MAX_AGE_MS); // mtime === cutoff
    const res = pruneStaleSessionDirs(root, SESSION_DIR_MAX_AGE_MS, { now: NOW });
    expect(res.removed).toBe(0);
    expect(fs.existsSync(path.join(root, 'edge'))).toBe(true);
  });

  it('ignores plain files in the sessions root (only dirs are sessions)', () => {
    fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
    const t = ageMs(30 * DAY);
    fs.utimesSync(path.join(root, 'stray.txt'), t, t);
    const res = pruneStaleSessionDirs(root, SESSION_DIR_MAX_AGE_MS, { now: NOW });
    expect(res.removed).toBe(0);
    expect(fs.existsSync(path.join(root, 'stray.txt'))).toBe(true);
  });

  it('returns {removed:0} without throwing when the sessions dir does not exist', () => {
    const res = pruneStaleSessionDirs(path.join(root, 'nope'), SESSION_DIR_MAX_AGE_MS, { now: NOW });
    expect(res).toEqual({ removed: 0, names: [] });
  });

  it('reports the names of reaped dirs so callers can evict their caches (fix #1/#5)', () => {
    mkSession('U1-C1-aaa', 10 * DAY);
    mkSession('U2-C2-bbb', 10 * DAY);
    mkSession('U3-C3-ccc', 1 * DAY);
    const res = pruneStaleSessionDirs(root, SESSION_DIR_MAX_AGE_MS, { now: NOW });
    expect(new Set(res.names)).toEqual(new Set(['U1-C1-aaa', 'U2-C2-bbb']));
  });
});

describe('pruneStaleSessionDirs — protect set (fix #4: never reap a live session)', () => {
  it('keeps an over-age dir whose name is protected', () => {
    mkSession('live', 30 * DAY);
    mkSession('dead', 30 * DAY);
    const res = pruneStaleSessionDirs(root, SESSION_DIR_MAX_AGE_MS, {
      now: NOW,
      protect: new Set(['live']),
    });
    expect(res.names).toEqual(['dead']);
    expect(fs.existsSync(path.join(root, 'live'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dead'))).toBe(false);
  });
});

describe('pruneStaleSessionDirs — symlinked children (fix #2: lstat, do not follow)', () => {
  it('reaps a stale dir even when it holds a freshly-touched knowledge symlink, and leaves the target intact', () => {
    // Shared knowledge target, touched "now" — its mtime must NOT keep the session alive.
    const shared = path.join(root, '_shared_knowledge');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'wiki.md'), 'shared');

    const sessionDir = mkSession('stale', 10 * DAY);
    fs.symlinkSync(shared, path.join(sessionDir, 'knowledge'), 'dir');
    // Re-stamp the session dir old AFTER adding the symlink (symlink add bumped mtime).
    const t = ageMs(10 * DAY);
    fs.utimesSync(sessionDir, t, t);

    const res = pruneStaleSessionDirs(root, SESSION_DIR_MAX_AGE_MS, { now: NOW });
    expect(res.names).toContain('stale');
    expect(fs.existsSync(sessionDir)).toBe(false);
    // rmSync unlinks the symlink, it must not delete the shared target.
    expect(fs.existsSync(path.join(shared, 'wiki.md'))).toBe(true);
  });
});

describe('pruneStaleSessionDirs — own mtime is the signal (fix #3: no deep walk)', () => {
  it('reaps a dir whose own mtime is old even if a deep child file is fresh', () => {
    const dir = mkSession('stale', 10 * DAY, { 'repos/clone/file.ts': 'recent edit' });
    // Touch a deep file "now"; the dir's own mtime stays old (set by mkSession).
    fs.utimesSync(path.join(dir, 'repos/clone/file.ts'), ageMs(0), ageMs(0));
    const t = ageMs(10 * DAY);
    fs.utimesSync(dir, t, t);
    const res = pruneStaleSessionDirs(root, SESSION_DIR_MAX_AGE_MS, { now: NOW });
    expect(res.names).toContain('stale');
  });

  it('markSessionUsed bumps the dir mtime so a would-be-stale session is kept', () => {
    const dir = mkSession('revived', 10 * DAY);
    markSessionUsed(dir); // simulate a turn opening the session
    const res = pruneStaleSessionDirs(root, SESSION_DIR_MAX_AGE_MS, { now: NOW });
    expect(res.removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('markSessionUsed — best-effort (never breaks a turn)', () => {
  it('does not throw when the dir does not exist', () => {
    expect(() => markSessionUsed(path.join(root, 'missing'))).not.toThrow();
  });
});
