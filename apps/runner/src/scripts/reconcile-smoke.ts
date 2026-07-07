/**
 * @fileoverview Manual smoke — runs the REAL reconcile pass (live model) over a
 * seeded set with duplicates + a contradiction + a pinned memory, on a COPY of
 * the local DB. Run: npx tsx src/scripts/reconcile-smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createSqliteAdapter, setDb, getDb, type Agent } from '@slackhive/shared';
import { getAgentMemories, upsertMemory } from '../db';
import { reconcileMemories } from '../memory-reconcile';

async function main(): Promise<void> {
  const real = path.join(os.homedir(), '.slackhive', 'data.db');
  const tmp = path.join(os.tmpdir(), `reconcile-smoke-${Date.now()}.db`);
  fs.copyFileSync(real, tmp);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(real + ext)) fs.copyFileSync(real + ext, tmp + ext);
  setDb(createSqliteAdapter(tmp));
  // Clean the DB copy on ANY exit (incl. errors) so a failed run never leaks it.
  process.once('exit', () => { for (const p of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } } });

  const id = randomUUID();
  await getDb().query('INSERT INTO agents (id, slug, name, model) VALUES ($1,$2,$3,$4)', [id, `rc-${id.slice(0, 6)}`, 'RC', 'claude-opus-4-8']);
  const agent = { id, slug: 'rc', name: 'RC' } as unknown as Agent;

  // Seed: 2 duplicates, a contradiction pair, and a pinned rule (must survive).
  await upsertMemory(id, 'reference', 'gmv_excl_cancelled', 'GMV excludes cancelled bookings.');
  await upsertMemory(id, 'reference', 'gmv_no_cancelled', 'When computing GMV, cancelled bookings are excluded.');
  await upsertMemory(id, 'user', 'aman_short', 'aman prefers very short answers.', { scopeUserId: 'U08AMAN9Z' });
  await upsertMemory(id, 'user', 'aman_long', 'aman now prefers long, detailed answers with the SQL.', { scopeUserId: 'U08AMAN9Z' });
  await upsertMemory(id, 'feedback', 'never_touch', 'Always double-check numbers before posting.', { pinned: true });
  await upsertMemory(id, 'reference', 'unique_fact', 'Bookings table is core.t1_bi_bookings.');

  console.log('BEFORE:');
  for (const m of await getAgentMemories(id)) console.log(`  [${m.type}]${m.pinned ? ' (pinned)' : ''} ${m.name}: ${m.content}`);

  console.log('\nRunning reconcile (REAL model)…');
  const t0 = Date.now();
  const res = await reconcileMemories(agent, await getAgentMemories(id), { apply: true });
  console.log(`applied=${res.applied}  (${Date.now() - t0}ms)`);
  console.log('ops:', JSON.stringify(res.ops));

  console.log('\nAFTER:');
  for (const m of await getAgentMemories(id)) console.log(`  [${m.type}]${m.pinned ? ' (pinned)' : ''} ${m.name}: ${m.content}`);

  fs.rmSync(tmp, { force: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(tmp + ext, { force: true });
}
main().then(() => process.exit(0)).catch(e => { console.error('SMOKE FAILED:', e); process.exit(1); });
