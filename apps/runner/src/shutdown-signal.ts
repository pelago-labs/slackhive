/**
 * @fileoverview Process-wide flag set by the runner's SIGTERM/SIGINT handler
 * before it begins graceful shutdown. MessageHandler reads it in the abort
 * branch so it can leave the activity row as `in_progress` instead of
 * finalizing it as `error`. The next process's `sweepStaleActivities` then
 * picks it up and auto-replay can resume the work.
 *
 * Why a module flag instead of constructor injection: AgentRunner builds a
 * MessageHandler per agent and there's no shared per-runner context object
 * passed in. A single mutable boolean on a module is the cheapest seam.
 *
 * @module runner/shutdown-signal
 */

let shuttingDown = false;

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test-only — reset between cases. */
export function _resetShutdownSignalForTests(): void {
  shuttingDown = false;
}
