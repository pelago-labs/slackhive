/**
 * @fileoverview Per-agent sensitivity settings: schema defaults, the
 * sensitivity_check CHECK constraint, and the rowToAgent mapping (via getAgentById).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter, setDb, getDb, closeDb } from '@slackhive/shared';
import { getAgentById } from '../db';

let dbPath: string;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sens-'));
  dbPath = path.join(dir, 'data.db');
  setDb(createSqliteAdapter(dbPath));
});
afterEach(async () => {
  await closeDb();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('agent sensitivity settings', () => {
  it('defaults to deterministic mode with redaction off', async () => {
    await getDb().query(`INSERT INTO agents (id, slug, name, model) VALUES ('a1','a1','A','m')`);
    const a = await getAgentById('a1');
    expect(a?.sensitivityCheck).toBe('deterministic');
    expect(a?.enforcementRedaction).toBe(false);
  });

  it('round-trips smart mode + redaction on', async () => {
    await getDb().query(`INSERT INTO agents (id, slug, name, model, sensitivity_check, enforcement_redaction) VALUES ('a2','a2','A','m','smart',1)`);
    const a = await getAgentById('a2');
    expect(a?.sensitivityCheck).toBe('smart');
    expect(a?.enforcementRedaction).toBe(true);
  });

  it('accepts off and rejects an invalid mode (CHECK constraint)', async () => {
    await getDb().query(`INSERT INTO agents (id, slug, name, model, sensitivity_check) VALUES ('a3','a3','A','m','off')`);
    expect((await getAgentById('a3'))?.sensitivityCheck).toBe('off');
    await expect(
      getDb().query(`INSERT INTO agents (id, slug, name, model, sensitivity_check) VALUES ('a4','a4','A','m','bogus')`),
    ).rejects.toThrow();
  });
});
