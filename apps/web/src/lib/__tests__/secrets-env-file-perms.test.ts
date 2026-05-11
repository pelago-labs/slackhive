/**
 * @fileoverview Unit tests for `assertEnvFileLockedDown`.
 *
 * Pins the boot-time guard that refuses to start if `.env` is group/world
 * readable. The .env file holds AUTH_SECRET / ENV_SECRET_KEY / ADMIN_PASSWORD;
 * loose mode (e.g. 664) leaks them to any process on the host.
 *
 * Tested cases:
 *   - mode 600 → passes silently
 *   - mode 644 → throws with a clear chmod hint
 *   - mode 664 → throws (the bug we just hit in prod)
 *   - missing file → no-op (env from systemd / docker is a valid shape)
 *   - dev mode → check skipped (allows local hacking without chmod)
 *   - check is once-only (idempotent — multiple secret reads don't re-stat)
 *
 * @module web/lib/__tests__/secrets-env-file-perms
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertEnvFileLockedDown, _resetEnvFilePermsCheckForTests } from '../secrets';

// Next.js declares process.env.NODE_ENV as read-only via its TS overrides
// (`'development' | 'production' | 'test'`), so direct assignment fails
// `tsc --noEmit` even though Vitest mutates it at runtime without complaint.
// Re-typing process.env as a plain string-map for these tests sidesteps the
// declaration without using `as any` everywhere.
const env = process.env as Record<string, string | undefined>;

describe('assertEnvFileLockedDown', () => {
  let tmpDir: string;
  let envPath: string;
  let originalNodeEnv: string | undefined;
  let originalCi: string | undefined;
  let originalSlackhiveEnvFile: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slackhive-env-perms-test-'));
    envPath = path.join(tmpDir, '.env');
    originalNodeEnv = env.NODE_ENV;
    originalCi = env.CI;
    originalSlackhiveEnvFile = env.SLACKHIVE_ENV_FILE;
    // Force non-dev / non-test mode so the check actually runs.
    env.NODE_ENV = 'production';
    delete env.CI;
    env.SLACKHIVE_ENV_FILE = envPath;
    _resetEnvFilePermsCheckForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
    if (originalCi === undefined) delete env.CI;
    else env.CI = originalCi;
    if (originalSlackhiveEnvFile === undefined) delete env.SLACKHIVE_ENV_FILE;
    else env.SLACKHIVE_ENV_FILE = originalSlackhiveEnvFile;
    _resetEnvFilePermsCheckForTests();
  });

  it('passes silently when .env is mode 600 (owner read/write only)', () => {
    fs.writeFileSync(envPath, 'AUTH_SECRET=x\n', { mode: 0o600 });
    expect(() => assertEnvFileLockedDown()).not.toThrow();
  });

  it('throws when .env is mode 644 (world readable) with a chmod hint', () => {
    fs.writeFileSync(envPath, 'AUTH_SECRET=x\n');
    fs.chmodSync(envPath, 0o644);
    try {
      assertEnvFileLockedDown();
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/insecure permissions/);
      expect(msg).toMatch(/644/);
      expect(msg).toMatch(/chmod 600/);
      expect(msg).toContain(envPath);
    }
  });

  it('throws when .env is mode 664 (group + world readable — the bug we hit)', () => {
    fs.writeFileSync(envPath, 'AUTH_SECRET=x\n');
    fs.chmodSync(envPath, 0o664);
    expect(() => assertEnvFileLockedDown()).toThrow(/664/);
  });

  it('no-ops when .env file is missing (env from systemd / docker is valid)', () => {
    // No file written to envPath; SLACKHIVE_ENV_FILE points at it.
    expect(() => assertEnvFileLockedDown()).not.toThrow();
  });

  it('skips the check in development mode (allows local hacking without chmod)', () => {
    env.NODE_ENV = 'development';
    delete env.CI;
    fs.writeFileSync(envPath, 'AUTH_SECRET=x\n');
    fs.chmodSync(envPath, 0o644);
    expect(() => assertEnvFileLockedDown()).not.toThrow();
  });

  it('skips the check when NODE_ENV=test so vitest noise does not couple to host mode', () => {
    env.NODE_ENV = 'test';
    delete env.CI;
    fs.writeFileSync(envPath, 'AUTH_SECRET=x\n');
    fs.chmodSync(envPath, 0o644);
    expect(() => assertEnvFileLockedDown()).not.toThrow();
  });

  it('is idempotent — second call does not re-stat (so a chmod between calls is not re-checked)', () => {
    fs.writeFileSync(envPath, 'AUTH_SECRET=x\n', { mode: 0o600 });
    expect(() => assertEnvFileLockedDown()).not.toThrow();
    // Now make it loose. Without the once-flag this would throw.
    fs.chmodSync(envPath, 0o644);
    expect(() => assertEnvFileLockedDown()).not.toThrow();
  });
});
