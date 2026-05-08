/**
 * Next.js boot-time instrumentation.
 *
 * Runs once per server start. Splits Node-only logic into a separate file
 * (`./instrumentation-node`) which is dynamically imported only when the
 * runtime is Node.js — this keeps the Edge runtime bundle from trying to
 * resolve `better-sqlite3`, `crypto`, and other Node built-ins that the
 * boss-registry transitively pulls in.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
