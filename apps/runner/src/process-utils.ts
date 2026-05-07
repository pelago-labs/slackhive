/**
 * @fileoverview Best-effort process discovery + graceful kill helpers.
 *
 * Used by ClaudeHandler.destroy to find and reap orphaned Claude SDK
 * subprocesses that didn't shut down cooperatively. The Claude Agent SDK
 * spawns the underlying `claude` binary internally, so we can't track the
 * PID at spawn time — we identify it after the fact via the AGENT_SLUG env
 * var, which the runner exports before invoking the SDK.
 *
 * @module runner/process-utils
 */

import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { Logger } from 'winston';

/**
 * Returns the PIDs of every process whose environment contains `envVar=value`.
 * Skips the calling process. Returns [] on platforms without env-var process
 * inspection (anything other than Linux/macOS).
 */
export function findProcessesByEnv(envVar: string, value: string): number[] {
  const needle = `${envVar}=${value}`;
  if (process.platform === 'linux') {
    let entries: string[];
    try { entries = fs.readdirSync('/proc'); } catch { return []; }
    const pids: number[] = [];
    for (const entry of entries) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      try {
        const buf = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
        if (buf.split('\0').includes(needle)) pids.push(pid);
      } catch {
        // process exited mid-scan, or no permission — skip
      }
    }
    return pids;
  }
  if (process.platform === 'darwin') {
    try {
      // -E shows env, -ww disables truncation, -o pid,command keeps parsing simple
      const out = execFileSync('ps', ['-Ewwo', 'pid,command'], {
        encoding: 'utf-8',
        timeout: 2_000,
      });
      const pids: number[] = [];
      for (const line of out.split('\n').slice(1)) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === process.pid) continue;
        if (m[2].includes(needle)) pids.push(pid);
      }
      return pids;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Sends SIGTERM to each PID, polls for up to {@link graceMs}, then SIGKILLs
 * any survivors. Errors (already-dead, no permission) are swallowed — this is
 * a best-effort reaper, not a correctness check.
 */
export async function killProcessesGracefully(
  pids: number[],
  graceMs: number,
  log?: Logger,
): Promise<void> {
  if (pids.length === 0) return;

  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (pids.every((p) => !isAlive(p))) return;
    await sleep(100);
  }

  const survivors = pids.filter(isAlive);
  if (survivors.length === 0) return;
  for (const pid of survivors) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
  log?.warn('SIGKILLed unresponsive subprocesses', { pids: survivors });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
