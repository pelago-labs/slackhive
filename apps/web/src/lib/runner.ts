/**
 * @fileoverview Internal runner HTTP base URL — the one place the web layer
 * resolves where the runner's internal control endpoints live. Kept in a single
 * helper so the host/port (and any future auth header) is defined once instead of
 * being re-derived in every route that proxies to the runner.
 *
 * @module web/lib/runner
 */

/** Base URL for the runner's internal HTTP server (loopback, default port 3002). */
export function runnerBase(): string {
  const port = process.env.RUNNER_INTERNAL_PORT ?? '3002';
  return `http://127.0.0.1:${port}`;
}
