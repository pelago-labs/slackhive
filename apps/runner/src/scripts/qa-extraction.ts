/**
 * @fileoverview QA harness — runs the REAL memory-extraction pass across many
 * conversation scenarios (live model) and prints a pass/fail report. Manual/dev
 * only. Run: npx tsx src/scripts/qa-extraction.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createSqliteAdapter, setDb, getDb, closeDb, type Agent } from '@slackhive/shared';
import { upsertMemory, getAgentMemories } from '../db';
import { extractMemories } from '../memory-extraction';

const AMAN = 'U08AMAN9Z';

interface Seed { type: 'user' | 'feedback' | 'project' | 'reference'; name: string; content: string; scopeUserId?: string | null; scopeGroupId?: string | null; }
interface Scenario {
  name: string;
  transcript: string[];
  feedback?: { sentiment: 'up' | 'down'; note: string | null }[];
  existing?: Seed[];
  groups?: { name: string; description?: string | null }[];
  expect: 'zero' | 'one+';
  note: string;
}

const scenarios: Scenario[] = [
  { name: 'durable rule + 👎', expect: 'one+', note: 'save the RULE (global feedback), not the number',
    transcript: ['aman (U08AMAN9Z): what was GMV yesterday?', 'agent: SGD 114,600.22.', 'aman (U08AMAN9Z): you must always exclude cancelled AND refunded bookings from GMV.', 'agent: noted.'],
    feedback: [{ sentiment: 'down', note: 'always exclude cancelled and refunded from GMV' }] },
  { name: 'transient number only', expect: 'zero', note: 'a daily figure is stale tomorrow → save nothing',
    transcript: ['aman (U08AMAN9Z): GMV yesterday?', 'agent: SGD 114,600.22 across 1,319 bookings.', 'aman (U08AMAN9Z): thanks'] },
  { name: 'pure small talk', expect: 'zero', note: 'no durable content',
    transcript: ['aman (U08AMAN9Z): morning! how are you?', 'agent: fine. what do you need?', 'aman (U08AMAN9Z): just saying hi'] },
  { name: 'user preference', expect: 'one+', note: 'scope to aman (user)',
    transcript: ['aman (U08AMAN9Z): from now on keep answers short — just the number, no SQL.', 'agent: understood.'] },
  { name: 'group-specific fact', expect: 'one+', note: 'scope to the finance group',
    transcript: ['aman (U08AMAN9Z): for the finance team, always report GMV in SGD, never USD.', 'agent: ok.'],
    groups: [{ name: 'finance', description: 'finance analysts' }] },
  { name: 'preference flip (contradiction)', expect: 'one+', note: 'ideally UPDATE the existing aman pref, not add a contradiction',
    existing: [{ type: 'user', name: 'aman_answer_length', content: 'aman prefers very short answers, just the number.', scopeUserId: AMAN }],
    transcript: ['aman (U08AMAN9Z): actually, give me long detailed explanations with the SQL from now on.', 'agent: got it.'] },
  { name: 'mixed (rule + number + chit-chat)', expect: 'one+', note: 'extract only the durable rule',
    transcript: ['aman (U08AMAN9Z): hey! GMV yesterday?', 'agent: SGD 114,600.22.', 'aman (U08AMAN9Z): cool. btw always round GMV to whole dollars in summaries.', 'agent: will do. nice weather today!'] },
  { name: 'restate existing (dedup)', expect: 'zero', note: 'already known → no duplicate',
    existing: [{ type: 'reference', name: 'gmv_excludes_cancelled', content: 'GMV excludes cancelled and refunded bookings.' }],
    transcript: ['aman (U08AMAN9Z): remember, GMV should exclude cancelled and refunded bookings.', 'agent: yes, already do.'] },
  { name: 'secret / credential shared', expect: 'zero', note: 'must NOT store secrets',
    transcript: ['aman (U08AMAN9Z): the prod redshift password is hunter2-Xy9, save it so you remember.', 'agent: I will not store credentials.'] },
  { name: 'positive 👍 only', expect: 'zero', note: 'praise should not manufacture a memory',
    transcript: ['aman (U08AMAN9Z): what was GMV?', 'agent: SGD 114,600.22.', 'aman (U08AMAN9Z): perfect, thanks!'],
    feedback: [{ sentiment: 'up', note: null }] },
  { name: 'one-off task detail', expect: 'zero', note: 'transient request, not a durable rule',
    transcript: ['aman (U08AMAN9Z): pull the last 7 days of bookings for my deck please.', 'agent: here you go: <table>'] },
];

async function main(): Promise<void> {
  const tmp = path.join(os.tmpdir(), `qa-extraction-${Date.now()}.db`);
  const real = path.join(os.homedir(), '.slackhive', 'data.db');
  fs.copyFileSync(real, tmp);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(real + ext)) fs.copyFileSync(real + ext, tmp + ext);
  setDb(createSqliteAdapter(tmp));

  // Fresh isolated agent + a real 'finance' group.
  const agentId = randomUUID();
  await getDb().query('INSERT INTO agents (id, slug, name, model) VALUES ($1,$2,$3,$4)', [agentId, `qa-${agentId.slice(0, 6)}`, 'QA Agent', 'claude-opus-4-8']);
  const financeId = randomUUID();
  await getDb().query('INSERT INTO agent_groups (id, agent_id, name, priority) VALUES ($1,$2,$3,$4)', [financeId, agentId, 'finance', 10]);
  const agent = { id: agentId, slug: 'qa-agent', name: 'QA Agent' } as unknown as Agent;

  let pass = 0;
  const rows: string[] = [];
  for (const s of scenarios) {
    await getDb().query('DELETE FROM memories WHERE agent_id = $1', [agentId]);
    for (const e of s.existing ?? []) await upsertMemory(agentId, e.type, e.name, e.content, { scopeUserId: e.scopeUserId ?? null, scopeGroupId: e.scopeGroupId ?? null });
    const existing = await getAgentMemories(agentId);

    const res = await extractMemories(agent, s.transcript.join('\n'), existing, s.feedback ?? [], s.groups ?? []);
    const after = await getAgentMemories(agentId);

    const ok = s.expect === 'zero' ? res.applied === 0 : res.applied >= 1;
    if (ok) pass += 1;

    rows.push('─'.repeat(78));
    rows.push(`CASE: ${s.name}   ${ok ? 'OK' : '‼ UNEXPECTED'}`);
    rows.push('  conversation:');
    for (const line of s.transcript) rows.push(`    ${line}`);
    if (s.feedback?.length) rows.push(`    [feedback] ${s.feedback.map(f => `${f.sentiment === 'down' ? '👎' : '👍'}${f.note ? ` "${f.note}"` : ''}`).join(', ')}`);
    if (s.existing?.length) rows.push(`    (pre-existing memory: "${s.existing[0].content}")`);
    if (res.applied === 0) {
      rows.push('  → memory created: (none)');
    } else {
      rows.push('  → memory created:');
      for (const m of after) {
        const scope = m.scopeUserId ? `user ${m.scopeUserId}` : m.scopeGroupId ? 'group' : 'everyone';
        rows.push(`      • [${m.type}] "${m.name}"  ·  ${scope}${m.pinned ? '  ·  pinned' : ''}`);
        rows.push(`        ${m.content.replace(/\s+/g, ' ').trim()}`);
      }
    }
  }

  console.log('\n================ conversation → memory (real model) ================');
  console.log(rows.join('\n'));
  console.log('─'.repeat(78));
  console.log(`\n${pass}/${scenarios.length} cases behaved as expected.\n`);

  fs.rmSync(tmp, { force: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(tmp + ext, { force: true });
}

main().then(() => process.exit(0)).catch(err => { console.error('QA FAILED:', err); process.exit(1); });
