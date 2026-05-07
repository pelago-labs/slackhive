/**
 * @fileoverview One-shot backfill: fill in `description` for every skill row
 * that's still NULL.
 *
 * Use this when you don't want to wait for the next runner restart's sweep
 * (or aren't running the runner at all). The behavior is identical to
 * AgentRunner.sweepMissingSkillDescriptions but executes from a standalone
 * tsx invocation so it can be run before a release.
 *
 * Usage:
 *   npx tsx apps/runner/src/scripts/backfill-skill-descriptions.ts
 *
 * Env:
 *   ANTHROPIC_API_KEY — required (script exits 0 with a warning if unset).
 *
 * @module runner/scripts/backfill-skill-descriptions
 */

import 'dotenv/config';
import { initDb } from '@slackhive/shared';
import { getSkillsMissingDescription, updateSkillDescription } from '../db';
import { summarizeSkill } from '../summarize-skill';
import { logger } from '../logger';

async function main(): Promise<void> {
  // Auth check intentionally omitted — the SDK pulls credentials from
  // ANTHROPIC_API_KEY *or* the host keychain (`claude login`). We surface a
  // failure per-skill instead of pre-flighting the whole run.

  await initDb();
  const missing = await getSkillsMissingDescription();
  if (missing.length === 0) {
    console.log('No skills missing description.');
    return;
  }

  console.log(`Backfilling ${missing.length} skill description(s)…\n`);
  let filled = 0;
  let skipped = 0;
  for (const skill of missing) {
    const description = await summarizeSkill(skill.filename, skill.content);
    if (description) {
      await updateSkillDescription(skill.id, description);
      console.log(`  ✓ ${skill.filename} — ${description}`);
      filled++;
    } else {
      console.log(`  - ${skill.filename}: summarizer returned null, leaving NULL`);
      skipped++;
    }
  }

  console.log(`\nDone. Filled ${filled}, skipped ${skipped}, total ${missing.length}.`);
}

main().catch((err) => {
  logger.error('Backfill failed', { error: (err as Error).message });
  process.exitCode = 1;
});
