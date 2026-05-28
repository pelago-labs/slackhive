/**
 * @fileoverview Tests for the shutdown-signal module + the gate it controls
 * in MessageHandler's abort branch.
 *
 * Why this exists: graceful `slackhive stop` aborts every in-flight Claude
 * call. Pre-fix, the abort handler immediately closed the activity row as
 * `error/aborted`. The next process's `sweepStaleActivities` then saw nothing
 * `in_progress` and auto-replay never fired — graceful restarts silently
 * dropped in-flight work. Fix: when shutdown is in progress, leave the row
 * `in_progress` so the next sweep picks it up.
 *
 * @module runner/__tests__/shutdown-signal
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  isShuttingDown,
  markShuttingDown,
  _resetShutdownSignalForTests,
} from '../shutdown-signal';

describe('shutdown-signal module', () => {
  beforeEach(() => _resetShutdownSignalForTests());
  afterEach(() => _resetShutdownSignalForTests());

  it('starts false', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('becomes true after markShuttingDown()', () => {
    markShuttingDown();
    expect(isShuttingDown()).toBe(true);
  });

  it('is idempotent — repeated calls stay true', () => {
    markShuttingDown();
    markShuttingDown();
    expect(isShuttingDown()).toBe(true);
  });
});

describe('shutdown-signal wiring (source-text contract)', () => {
  // Structural tests: the runtime behaviour relies on three small wiring
  // points. If any of them goes missing, in-flight work will silently drop
  // on the next graceful restart. These tests fail loudly when the wiring
  // regresses, even before anyone notices in production.
  const runnerSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/agent-runner.ts'),
    'utf-8',
  );
  const handlerSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/message-handler.ts'),
    'utf-8',
  );

  it('agent-runner imports markShuttingDown', () => {
    expect(runnerSrc).toMatch(/import\s*\{\s*markShuttingDown\s*\}\s*from\s*['"]\.\/shutdown-signal['"]/);
  });

  it('agent-runner sets the shutdown flag BEFORE awaiting stop()', () => {
    // The flag must be set first so any abort-driven activity finalization
    // racing with the shutdown sees `isShuttingDown() === true` and skips.
    const idxMark = runnerSrc.indexOf('markShuttingDown()');
    const idxStop = runnerSrc.indexOf('await this.stop()');
    expect(idxMark).toBeGreaterThan(0);
    expect(idxStop).toBeGreaterThan(0);
    expect(idxMark).toBeLessThan(idxStop);
  });

  it('message-handler imports isShuttingDown', () => {
    expect(handlerSrc).toMatch(/import\s*\{\s*isShuttingDown\s*\}\s*from\s*['"]\.\/shutdown-signal['"]/);
  });

  it('message-handler abort branch skips closeActivity when shutting down', () => {
    // The abort catch block must gate closeActivity behind !isShuttingDown().
    // Use a regex that tolerates whitespace/wrapping changes but enforces
    // both the `recorder &&` check and the `!isShuttingDown()` guard sit
    // around the closeActivity call inside the AbortError branch.
    expect(handlerSrc).toMatch(
      /if\s*\(\s*recorder\s*&&\s*!isShuttingDown\(\)\s*\)\s*\{\s*await\s+this\.closeActivity\(\s*recorder\.activityId\s*,\s*'error'\s*,\s*'aborted'\s*\)/,
    );
  });
});
