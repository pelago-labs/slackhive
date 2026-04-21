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

// Sync Claude credentials from system Keychain to ~/.claude/.credentials.json
// so the SDK can authenticate (same way claude CLI does)
(async () => {
  try {
    const { execSync } = await import('child_process');
    const fs = await import('fs');
    const path = await import('path');
    const claudeDir = path.join(process.env.HOME || '/tmp', '.claude');
    const credPath = path.join(claudeDir, '.credentials.json');

    // Try reading from OS keychain
    let creds: string | null = null;
    try {
      // macOS Keychain
      creds = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      try {
        // Linux GNOME Keyring
        creds = execSync('secret-tool lookup service "Claude Code-credentials"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch { /* no keychain available */ }
    }

    if (creds) {
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(credPath, creds, { mode: 0o600 });
      logger.info('Claude credentials synced from system keychain');
    }
  } catch { /* non-fatal */ }
})();

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
