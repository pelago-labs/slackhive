/**
 * @fileoverview Tests for process-utils.findProcessesByEnv + killProcessesGracefully.
 *
 * findProcessesByEnv is platform-specific (Linux: procfs environ files,
 * macOS: ps -E, other: empty). The test sets a unique env var on a child
 * `sleep` process and asserts the helper finds its PID — same shape on
 * Linux + macOS, skipped on Windows.
 *
 * killProcessesGracefully is exercised against a child `sleep` process and
 * asserted dead within the grace window.
 *
 * @module runner/__tests__/process-utils.test
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { findProcessesByEnv, killProcessesGracefully } from '../process-utils.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

describe.skipIf(!supported)('findProcessesByEnv', () => {
  it('finds a child process by a unique env var=value', async () => {
    const marker = `slackhive-process-utils-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const child = spawn('sleep', ['10'], {
      env: { ...process.env, SLACKHIVE_TEST_MARKER: marker },
      stdio: 'ignore',
      detached: false,
    });
    try {
      // Give the OS a moment to flush /proc/<pid>/environ
      await new Promise((r) => setTimeout(r, 100));
      const pids = findProcessesByEnv('SLACKHIVE_TEST_MARKER', marker);
      expect(pids).toContain(child.pid);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('returns an empty list when no process has the marker', () => {
    const pids = findProcessesByEnv('SLACKHIVE_DEFINITELY_NOT_SET', 'nope-' + Date.now());
    expect(pids).toEqual([]);
  });
});

describe.skipIf(!supported)('killProcessesGracefully', () => {
  it('SIGTERM-then-SIGKILLs the given PIDs', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    expect(child.pid).toBeDefined();
    await killProcessesGracefully([child.pid!], 1_000);
    // Process is dead — kill(0) throws ESRCH
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  it('handles already-dead PIDs without throwing', async () => {
    await expect(killProcessesGracefully([999_999_999], 200)).resolves.not.toThrow();
  });

  it('no-ops on empty input', async () => {
    await expect(killProcessesGracefully([], 1_000)).resolves.not.toThrow();
  });
});
