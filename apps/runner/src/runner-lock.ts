/**
 * @fileoverview Single-instance lock for the runner process.
 *
 * Prevents two runner processes from racing on the shared SQLite DB by
 * taking an exclusive lock at `~/.slackhive/runner.lock` on startup.
 *
 * This is the root-cause fix for the Tuesday-`npm run dev` scenario where
 * a stray `tsx watch` from a prior session kept writing stale "Stopped"
 * rows into the agent table while the slackhive-managed runner also ran.
 *
 * @module runner/runner-lock
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export type RunnerMode = 'standalone' | 'dev';

interface LockPayload {
  pid: number;
  startedAt: string;
  mode: RunnerMode;
}

function lockPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.slackhive', 'runner.lock');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the runner lock or exit(1) if another runner is alive.
 *
 * A stale lock (previous process crashed without cleanup) is detected via
 * `process.kill(pid, 0)` and overwritten.
 */
export function acquireRunnerLock(mode: RunnerMode): void {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const payload: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    mode,
  };

  try {
    fs.writeFileSync(file, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    let existing: LockPayload | null = null;
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { /* malformed lock — treat as stale */ }

    if (existing && isAlive(existing.pid)) {
      logger.error('Another runner is already running — exiting', {
        existingPid: existing.pid,
        existingMode: existing.mode,
        existingStartedAt: existing.startedAt,
      });
      process.exit(1);
    }

    // Stale lock — overwrite.
    logger.warn('Overwriting stale runner lock', { stalePid: existing?.pid });
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  }

  const release = (): void => {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as LockPayload;
      if (parsed.pid === process.pid) fs.unlinkSync(file);
    } catch { /* already gone */ }
  };

  process.on('exit', release);
  process.on('SIGTERM', release);
  process.on('SIGINT', release);
  process.on('uncaughtException', (err) => {
    release();
    throw err;
  });
}

/** Read the current lock for diagnostics. Returns null if no lock file. */
export function readRunnerLock(): LockPayload | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath(), 'utf-8'));
  } catch {
    return null;
  }
}
