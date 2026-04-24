/**
 * @fileoverview Tests for writeFileSourcesToDisk — materializes file-type
 * knowledge sources from DB into knowledge/sources/<name>.md so the running
 * agent can Grep / Read the verbatim text at turn-time.
 *
 * @module runner/__tests__/write-file-sources.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteAdapter,
  setDb,
  getDb,
  closeDb,
} from '@slackhive/shared';
import { writeFileSourcesToDisk } from '../compile-claude-md';

let tmpRoot: string;
let workDir: string;

async function seedAgent(): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO agents (id, slug, name, persona, description, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, `slug-${id.slice(0, 8)}`, 'Test Agent', null, null, 'claude-opus-4-7'],
  );
  return id;
}

async function insertSource(agentId: string, opts: {
  type?: 'url' | 'file' | 'repo';
  name: string;
  content?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO knowledge_sources (id, agent_id, type, name, content, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [id, agentId, opts.type ?? 'file', opts.name, opts.content ?? null],
  );
  return id;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'write-file-sources-'));
  const dbPath = path.join(tmpRoot, 'data.db');
  workDir = path.join(tmpRoot, 'workdir');
  fs.mkdirSync(workDir, { recursive: true });
  setDb(createSqliteAdapter(dbPath));
});

afterEach(async () => {
  await closeDb();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('writeFileSourcesToDisk', () => {
  it('materializes one file-source per row to knowledge/sources/<name>.md', async () => {
    const agentId = await seedAgent();
    await insertSource(agentId, { name: 'api-spec', content: 'API details here' });
    await insertSource(agentId, { name: 'glossary', content: 'Term: definition' });

    await writeFileSourcesToDisk(workDir, agentId);

    const dir = path.join(workDir, 'knowledge', 'sources');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'api-spec.md'), 'utf8')).toBe('API details here');
    expect(fs.readFileSync(path.join(dir, 'glossary.md'), 'utf8')).toBe('Term: definition');
  });

  it('skips repo and url sources — only file type is materialized', async () => {
    const agentId = await seedAgent();
    await insertSource(agentId, { type: 'url', name: 'url-src', content: 'from a url' });
    await insertSource(agentId, { type: 'repo', name: 'repo-src', content: null });
    await insertSource(agentId, { type: 'file', name: 'file-src', content: 'file only' });

    await writeFileSourcesToDisk(workDir, agentId);

    const dir = path.join(workDir, 'knowledge', 'sources');
    expect(fs.readdirSync(dir).sort()).toEqual(['file-src.md']);
  });

  it('wipes stale files from a prior run — deletions propagate', async () => {
    const agentId = await seedAgent();
    const oldId = await insertSource(agentId, { name: 'old', content: 'old content' });
    await writeFileSourcesToDisk(workDir, agentId);
    expect(fs.existsSync(path.join(workDir, 'knowledge', 'sources', 'old.md'))).toBe(true);

    // Simulate deletion
    await getDb().query('DELETE FROM knowledge_sources WHERE id = $1', [oldId]);
    await insertSource(agentId, { name: 'new', content: 'new content' });
    await writeFileSourcesToDisk(workDir, agentId);

    const dir = path.join(workDir, 'knowledge', 'sources');
    expect(fs.readdirSync(dir).sort()).toEqual(['new.md']);
  });

  it('removes the sources/ dir entirely when no file sources remain', async () => {
    const agentId = await seedAgent();
    const id = await insertSource(agentId, { name: 'only', content: 'stuff' });
    await writeFileSourcesToDisk(workDir, agentId);
    expect(fs.existsSync(path.join(workDir, 'knowledge', 'sources', 'only.md'))).toBe(true);

    await getDb().query('DELETE FROM knowledge_sources WHERE id = $1', [id]);
    await writeFileSourcesToDisk(workDir, agentId);

    expect(fs.existsSync(path.join(workDir, 'knowledge', 'sources'))).toBe(false);
  });

  it('skips rows with empty content — no zero-byte files', async () => {
    const agentId = await seedAgent();
    await insertSource(agentId, { name: 'empty', content: '' });
    await insertSource(agentId, { name: 'null-content', content: null });
    await insertSource(agentId, { name: 'ok', content: 'real text' });

    await writeFileSourcesToDisk(workDir, agentId);

    const dir = path.join(workDir, 'knowledge', 'sources');
    expect(fs.readdirSync(dir).sort()).toEqual(['ok.md']);
  });

  it('sanitizes unsafe source names so they cannot escape the sources dir', async () => {
    const agentId = await seedAgent();
    await insertSource(agentId, { name: '../../etc/passwd', content: 'no escape' });
    await insertSource(agentId, { name: 'has spaces & weird?chars', content: 'yes' });

    await writeFileSourcesToDisk(workDir, agentId);

    const dir = path.join(workDir, 'knowledge', 'sources');
    const files = fs.readdirSync(dir);
    // No traversal artefacts written outside
    expect(files.every(f => !f.includes('/') && !f.includes('..'))).toBe(true);
    expect(files.length).toBe(2);
    // The "weird chars" name collapses to a slug
    expect(files.some(f => f.includes('has-spaces'))).toBe(true);
  });

  it('disambiguates sanitize-collision filenames — no silent overwrite', async () => {
    // "my file" and "my-file" both sanitize to "my-file.md". Without the hash
    // suffix the second write clobbered the first.
    const agentId = await seedAgent();
    await insertSource(agentId, { name: 'my file',  content: 'space-version' });
    await insertSource(agentId, { name: 'my-file',  content: 'dash-version' });

    await writeFileSourcesToDisk(workDir, agentId);

    const dir = path.join(workDir, 'knowledge', 'sources');
    const files = fs.readdirSync(dir).sort();
    expect(files.length).toBe(2);
    // One is the untouched slug, the other gets the hash suffix.
    expect(files).toContain('my-file.md');
    expect(files.some(f => /^my-file-[0-9a-f]{8}\.md$/.test(f))).toBe(true);
    // Both original contents survive.
    const contents = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).sort();
    expect(contents).toEqual(['dash-version', 'space-version']);
  });

  it('is isolated per agent — sources from other agents are not written', async () => {
    const a1 = await seedAgent();
    const a2 = await seedAgent();
    await insertSource(a1, { name: 'a1-only', content: 'agent one' });
    await insertSource(a2, { name: 'a2-only', content: 'agent two' });

    await writeFileSourcesToDisk(workDir, a1);

    const dir = path.join(workDir, 'knowledge', 'sources');
    expect(fs.readdirSync(dir).sort()).toEqual(['a1-only.md']);
  });
});
