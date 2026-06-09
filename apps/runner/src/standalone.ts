/**
 * @fileoverview Standalone entry point for non-Docker mode.
 *
 * Starts both the Next.js web server and the agent runner in a single
 * Node.js process. Uses SQLite + in-memory event bus (no Postgres/Redis).
 *
 * Usage:
 *   DATABASE_TYPE=sqlite node apps/runner/dist/standalone.js
 *
 * This is what `slackhive start` runs in non-Docker mode.
 *
 * @module runner/standalone
 */

import 'dotenv/config';
import { initDb, setEventBus, getEventBus } from '@slackhive/shared';
import { AgentRunner } from './agent-runner';
import { syncBackendCredentials } from './backends/credentials';
import { logger } from './logger';
import { acquireRunnerLock } from './runner-lock';
import { fork, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Ensure we're in SQLite mode
if (!process.env.DATABASE_TYPE) {
  process.env.DATABASE_TYPE = 'sqlite';
}

// Refuse to boot if another runner is already alive. Prevents stray dev-mode
// processes from racing on the shared DB (see runner-lock docstring).
acquireRunnerLock('standalone');

// Backend credentials are materialized from Settings (encrypted) by
// syncBackendCredentials() further below — no host Keychain / `claude login`
// dependency. (Claude → ~/.claude/.credentials.json, Codex → ~/.codex/auth.json.)

// Prevent a single bad agent from crashing the entire process
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — continuing', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection — continuing', { error: String(reason) });
});

let webProcess: ChildProcess | null = null;

async function startWeb(): Promise<void> {
  const webDir = path.resolve(__dirname, '../../web');

  // Check if the web app is built
  const nextDir = path.join(webDir, '.next');
  if (!fs.existsSync(nextDir)) {
    logger.info('Web app not built yet, building...');
    const { execSync } = await import('child_process');
    execSync('npx next build', { cwd: webDir, stdio: 'inherit' });
  }

  // Start Next.js as a child process
  const port = process.env.PORT ?? '3001';

  // Resolve the next binary — check local then root node_modules
  const projectRoot = path.resolve(webDir, '../..');
  let nextBin = path.join(webDir, 'node_modules', '.bin', 'next');
  if (!fs.existsSync(nextBin)) {
    nextBin = path.join(projectRoot, 'node_modules', '.bin', 'next');
  }

  const { spawn: spawnChild } = await import('child_process');
  webProcess = spawnChild(nextBin, ['start', '-p', port], {
    cwd: webDir,
    env: {
      ...process.env,
      PORT: port,
    },
    stdio: 'pipe',
  }) as unknown as ChildProcess;

  webProcess.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) logger.info(`[web] ${msg}`);
  });

  webProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) logger.warn(`[web] ${msg}`);
  });

  webProcess.on('exit', (code) => {
    logger.warn('Web process exited', { code });
    webProcess = null;
  });

  logger.info('Web server starting', { port });
}

async function main(): Promise<void> {
  logger.info('SlackHive starting in standalone mode (no Docker)');

  // Initialize the shared database
  await initDb();
  logger.info('Database initialized', { type: process.env.DATABASE_TYPE ?? 'sqlite' });

  // Materialize backend credentials (Claude/Codex) from the Settings page onto
  // disk/env — replaces the old `slackhive init` auth step.
  try {
    await syncBackendCredentials();
  } catch (err) {
    logger.warn('Backend credential sync failed (continuing)', { error: (err as Error).message });
  }

  // Initialize the shared event bus (in-memory since no Redis)
  const bus = getEventBus();
  logger.info('Event bus initialized', { type: bus.type });

  // Start the web server
  await startWeb();

  // Start the agent runner
  const runner = new AgentRunner();
  try {
    await runner.start();
  } catch (err) {
    logger.error('Failed to start AgentRunner', { error: (err as Error).message });
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await runner.stop();
    if (webProcess) {
      webProcess.kill();
      webProcess = null;
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('SlackHive standalone mode running', {
    web: `http://localhost:${process.env.PORT ?? '3001'}`,
    database: process.env.DATABASE_TYPE ?? 'sqlite',
  });
}

main();
