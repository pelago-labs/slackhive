/**
 * @fileoverview SQLite database backup engine for disaster recovery.
 *
 * Produces a consistent point-in-time snapshot of the LIVE database using
 * `VACUUM INTO` — safe to run while the runner is serving traffic (unlike `cp`,
 * which can copy a torn WAL state and corrupt the backup). Backups are written to
 * `~/.slackhive/backups/` with owner-only permissions (they contain the same
 * encrypted secrets as the primary DB) and pruned to a retention count.
 *
 * SQLite only — the single-host deployment. On Postgres this throws so callers can
 * surface "use pg_dump" rather than silently producing nothing.
 *
 * @module @slackhive/shared/db/backup
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './adapter';

/** Filename pattern for scheduled/manual backups — also the prune/download allowlist. */
export const BACKUP_NAME_RE = /^data-\d{8}-\d{6}\.db$/;
/** Safety snapshot taken right before a CLI restore overwrites the live DB. */
export const PRE_RESTORE_NAME_RE = /^pre-restore-\d{8}-\d{6}\.db$/;

/** Resolve the primary SQLite file the same way the adapter does. */
export function databasePath(): string {
  return (
    process.env.SQLITE_PATH ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.slackhive', 'data.db')
  );
}

/** The directory backups live in: a `backups/` sibling of the DB file. */
export function backupsDir(): string {
  return path.join(path.dirname(databasePath()), 'backups');
}

/** UTC timestamp `YYYYMMDD-HHMMSS` for backup filenames (sortable, no separators). */
function stamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export interface BackupInfo {
  name: string;
  bytes: number;
  /** Epoch ms of last modification. */
  mtime: number;
}

/**
 * Snapshot the live DB to `~/.slackhive/backups/<prefix>-<stamp>.db` via `VACUUM INTO`.
 * Returns the path + size. Owner-only (`0600`) — backups carry encrypted secrets.
 *
 * @param prefix `'data'` for normal backups, `'pre-restore'` for the pre-restore safety net.
 */
export async function backupDatabase(prefix: 'data' | 'pre-restore' = 'data'): Promise<{ path: string; bytes: number }> {
  const db = getDb();
  if (db.type !== 'sqlite') {
    throw new Error('Database backup is only supported on SQLite. For Postgres, use pg_dump.');
  }

  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const dest = path.join(dir, `${prefix}-${stamp()}.db`);
  // VACUUM INTO writes a consistent snapshot of the live DB; better-sqlite3 binds the
  // destination path. It cannot run inside a transaction — the adapter's write path
  // runs it directly, so this is safe.
  await db.query('VACUUM INTO $1', [dest]);

  try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
  return { path: dest, bytes: fs.statSync(dest).size };
}

/** List existing `data-*.db` backups, newest first. */
export function listBackups(): BackupInfo[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => BACKUP_NAME_RE.test(n))
    .map(n => {
      const st = fs.statSync(path.join(dir, n));
      return { name: n, bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Delete `data-*.db` backups beyond the newest `retain`. Returns how many were removed.
 * Only touches the `data-` prefix — `pre-restore-*` safety snapshots are never auto-pruned.
 */
export function pruneBackups(retain: number): number {
  const keep = Math.max(1, Math.floor(retain));
  const all = listBackups(); // newest first
  const toDelete = all.slice(keep);
  for (const b of toDelete) {
    try { fs.unlinkSync(path.join(backupsDir(), b.name)); } catch { /* ignore */ }
  }
  return toDelete.length;
}

/**
 * Resolve a backup filename to an absolute path INSIDE the backups dir, or null if the
 * name is invalid / escapes the directory (path-traversal guard for the download route).
 */
export function resolveBackupPath(name: string): string | null {
  if (!BACKUP_NAME_RE.test(name) && !PRE_RESTORE_NAME_RE.test(name)) return null;
  const dir = backupsDir();
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== path.resolve(dir)) return null; // no traversal
  return fs.existsSync(full) ? full : null;
}
