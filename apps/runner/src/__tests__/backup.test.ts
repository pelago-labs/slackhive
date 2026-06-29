import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createSqliteAdapter, setDb, closeDb, getDb, type DbAdapter } from '@slackhive/shared';
import { backupDatabase, listBackups, pruneBackups, resolveBackupPath, backupsDir } from '@slackhive/shared';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  process.env.SQLITE_PATH = path.join(tmpDir, 'data.db');
  setDb(createSqliteAdapter(process.env.SQLITE_PATH));
});

afterEach(async () => {
  await closeDb();
  delete process.env.SQLITE_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('backupDatabase', () => {
  it('writes a consistent snapshot that passes integrity_check and preserves rows', async () => {
    await getDb().query('CREATE TABLE t (id INTEGER)');
    await getDb().query('INSERT INTO t (id) VALUES (1), (2), (3)');

    const { path: bpath, bytes } = await backupDatabase();
    expect(fs.existsSync(bpath)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    expect(path.dirname(bpath)).toBe(backupsDir());
    // Owner-only perms (carries encrypted secrets in production).
    expect(fs.statSync(bpath).mode & 0o777).toBe(0o600);

    const copy = new Database(bpath, { readonly: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    expect((copy.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c).toBe(3);
    copy.close();
  });

  it('throws (not silently no-ops) on a non-SQLite adapter', async () => {
    await closeDb();
    setDb({ type: 'postgres', query: async () => ({ rows: [], rowCount: 0 }), transaction: async (fn) => fn({} as DbAdapter), close: async () => {} } as unknown as DbAdapter);
    await expect(backupDatabase()).rejects.toThrow(/SQLite/i);
  });
});

describe('listBackups / pruneBackups', () => {
  function fakeBackup(name: string, ageMs: number) {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x');
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }

  it('lists data-*.db newest-first and prunes to retain, keeping the newest', () => {
    fakeBackup('data-20260101-000000.db', 5000);
    fakeBackup('data-20260102-000000.db', 3000);
    fakeBackup('data-20260103-000000.db', 1000);
    fakeBackup('not-a-backup.txt', 1000); // ignored

    expect(listBackups().map(b => b.name)).toEqual([
      'data-20260103-000000.db', 'data-20260102-000000.db', 'data-20260101-000000.db',
    ]);

    const removed = pruneBackups(2);
    expect(removed).toBe(1);
    expect(listBackups().map(b => b.name)).toEqual([
      'data-20260103-000000.db', 'data-20260102-000000.db',
    ]);
  });

  it('never prunes pre-restore safety snapshots', () => {
    fakeBackup('data-20260101-000000.db', 1000);
    fakeBackup('pre-restore-20260101-000000.db', 1000);
    pruneBackups(0); // would keep at least 1 data-*; pre-restore is untouched
    expect(fs.existsSync(path.join(backupsDir(), 'pre-restore-20260101-000000.db'))).toBe(true);
  });
});

describe('resolveBackupPath (traversal guard)', () => {
  it('rejects traversal / invalid names and returns null for missing files', () => {
    expect(resolveBackupPath('../../etc/passwd')).toBeNull();
    expect(resolveBackupPath('data-bad.db')).toBeNull();
    expect(resolveBackupPath('data-20260101-000000.db')).toBeNull(); // valid name but missing
    fs.mkdirSync(backupsDir(), { recursive: true });
    fs.writeFileSync(path.join(backupsDir(), 'data-20260101-000000.db'), 'x');
    expect(resolveBackupPath('data-20260101-000000.db')).toContain('data-20260101-000000.db');
  });
});
