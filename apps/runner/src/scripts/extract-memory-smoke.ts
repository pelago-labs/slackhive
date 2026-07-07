/**
 * @fileoverview Manual smoke test — runs the REAL memory-extraction pass with a
 * live model call (no mocks) against a COPY of the local data.db (so the running
 * stack's DB is untouched). Not part of the automated suite (real LLM = slow +
 * non-deterministic).
 *
 * Run: npx tsx src/scripts/extract-memory-smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSqliteAdapter, setDb, getDb } from '@slackhive/shared';
import { getAgentById } from '../db';
import { extractMemories } from '../memory-extraction';

async function main(): Promise<void> {
  const real = path.join(os.homedir(), '.slackhive', 'data.db');
  const tmp = path.join(os.tmpdir(), `extract-smoke-${Date.now()}.db`);
  fs.copyFileSync(real, tmp);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(real + ext)) fs.copyFileSync(real + ext, tmp + ext);
  setDb(createSqliteAdapter(tmp));

  const { rows } = await getDb().query('SELECT id, slug FROM agents LIMIT 1');
  if (!rows.length) throw new Error('no agents in DB');
  const agent = await getAgentById(rows[0].id as string);
  if (!agent) throw new Error('agent not found');
  const backend = (await getDb().query("SELECT value FROM settings WHERE key = 'agentBackend'")).rows[0]?.value ?? 'claude';
  console.log(`Agent: ${agent.slug}   Backend: ${backend}   Model: ${agent.model ?? '(default)'}`);

  const kase = process.env.SMOKE_CASE ?? 'correction';
  const transcripts: Record<string, string[]> = {
    correction: [
      'aman: what was GMV yesterday?',
      'gilfoyle: SGD 114,600.22. Used core.t1_bi_bookings with booking_state in (CONFIRMED, FULFILLED, PENDING).',
      'aman: you forgot to exclude cancelled bookings. Always exclude cancelled AND refunded bookings from GMV.',
      'gilfoyle: noted.',
    ],
    chitchat: [
      'aman: morning! how are you today?',
      'gilfoyle: Functioning within parameters. What do you need?',
      'aman: haha nothing, just saying hi. thanks!',
      'gilfoyle: Noted. Ping me when you have a data question.',
    ],
    // Transient number ONLY — no rule, no feedback. Should save NOTHING (GMV
    // changes daily; the figure is stale tomorrow).
    number: [
      'aman: what was GMV yesterday?',
      'gilfoyle: Yesterday GMV was SGD 114,600.22 across 1,319 bookings.',
      'aman: thanks!',
    ],
    // Personal preference — should scope to aman's user id (U08AMAN9Z), not global.
    preference: [
      'aman (U08AMAN9Z): keep your answers short from now on — just the number, skip the SQL.',
      'gilfoyle: Understood. Terse it is.',
    ],
  };
  const transcript = (transcripts[kase] ?? transcripts.correction).join('\n');
  const feedback = kase === 'correction'
    ? [{ sentiment: 'down' as const, note: 'always exclude cancelled and refunded bookings from GMV' }]
    : [];
  const groups = (await getDb().query('SELECT name, description FROM agent_groups WHERE agent_id = $1', [agent.id]))
    .rows.map(r => ({ name: r.name as string, description: (r.description as string | null) ?? null }));

  console.log('\nTranscript:\n' + transcript);
  console.log('\nFeedback: ' + (feedback.length ? feedback.map(f => `${f.sentiment === 'down' ? '👎' : '👍'} "${f.note}"`).join(', ') : '(none)'));
  console.log('\nCalling extractMemories (REAL model)…');

  const t0 = Date.now();
  const res = await extractMemories(agent, transcript, [], feedback, groups);
  console.log(`\napplied=${res.applied}  (${Date.now() - t0}ms)`);

  const after = await getDb().query(
    'SELECT type, name, pinned, scope_user_id, content FROM memories WHERE agent_id = $1 ORDER BY updated_at DESC LIMIT 5',
    [agent.id],
  );
  console.log('\nMost-recent memories now in the (copied) DB:');
  for (const m of after.rows) {
    console.log(`  [${m.type}] ${m.name}${m.pinned ? ' (pinned)' : ''}${m.scope_user_id ? ` (user ${m.scope_user_id})` : ''}`);
    console.log(`      ${String(m.content).replace(/\s+/g, ' ').trim().slice(0, 180)}`);
  }

  fs.rmSync(tmp, { force: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(tmp + ext, { force: true });
}

main().then(() => process.exit(0)).catch(err => { console.error('SMOKE FAILED:', err); process.exit(1); });
