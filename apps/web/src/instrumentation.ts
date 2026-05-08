/**
 * Next.js boot-time instrumentation.
 * Runs once per server start — both `next dev` and production.
 *
 * - Regenerates every boss agent's claude_md from the current `boss-registry.ts`
 *   template, so template-only code changes propagate without needing a manual
 *   trigger or an unrelated agent CRUD event.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { regenerateBossRegistry } = await import('@/lib/boss-registry');
    await regenerateBossRegistry();
  } catch {
    // Boot-time regen is best-effort. The template still applies on the next
    // agent CRUD; we don't want a one-off failure to block the whole web app.
  }
}
