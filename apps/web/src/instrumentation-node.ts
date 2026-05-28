/**
 * Node-runtime-only instrumentation. Imported dynamically from
 * `./instrumentation.ts` so its DB / Node built-in dependencies are
 * never bundled for the Edge runtime.
 *
 * Regenerates every boss agent's claude_md from the current
 * `boss-registry.ts` template, so template-only code changes propagate
 * to the DB on web-app boot — without needing a manual trigger or an
 * unrelated agent CRUD event.
 */

import { regenerateBossRegistry } from '@/lib/boss-registry';

regenerateBossRegistry().catch(() => {
  // Boot-time regen is best-effort. The template still applies on the
  // next agent CRUD; we don't want a one-off failure to block the app.
});
