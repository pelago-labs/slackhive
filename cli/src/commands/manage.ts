/**
 * @fileoverview Management commands — start, stop, status, logs, update.
 *
 * Supports two modes:
 * - Docker mode: uses docker compose (default when docker-compose.yml exists)
 * - Native mode: runs Node.js processes directly (when --native flag or no Docker)
 *
 * @module cli/commands/manage
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import ora from 'ora';

// =============================================================================
// Project & mode detection
// =============================================================================

function findProjectDir(): string {
  if (existsSync(join(process.cwd(), 'docker-compose.yml')) || existsSync(join(process.cwd(), 'package.json'))) {
    return process.cwd();
  }
  const sub = join(process.cwd(), 'slackhive');
  if (existsSync(join(sub, 'docker-compose.yml')) || existsSync(join(sub, 'package.json'))) {
    return sub;
  }
  console.log(chalk.red('  Could not find SlackHive project.'));
  console.log(chalk.gray('  Run this command from the SlackHive directory, or run `slackhive init` first.'));
  process.exit(1);
}

/**
 * Always uses native mode (non-Docker).
 */
function useNativeMode(_dir: string): boolean {
  return true;
}

// =============================================================================
// PID file management (native mode)
// =============================================================================

function getSlackhiveDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.slackhive');
}

function getPidFile(): string {
  return join(getSlackhiveDir(), 'slackhive.pid');
}

function writePid(pid: number, webPort = 3001, internalPort = 3002): void {
  const dir = getSlackhiveDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getPidFile(), JSON.stringify({ pid, webPort, internalPort }));
}

interface PidInfo { pid: number; webPort: number; internalPort: number; }

function readPidInfo(): PidInfo | null {
  try {
    const raw = readFileSync(getPidFile(), 'utf-8').trim();
    let info: PidInfo;
    // Support old format (just a number) and new format (JSON)
    if (raw.startsWith('{')) {
      info = JSON.parse(raw);
    } else {
      info = { pid: parseInt(raw, 10), webPort: 3001, internalPort: 3002 };
    }
    process.kill(info.pid, 0); // Check if running
    return info;
  } catch {
    try { unlinkSync(getPidFile()); } catch { /* ignore */ }
    return null;
  }
}

function readPid(): number | null {
  const info = readPidInfo();
  return info?.pid ?? null;
  }
}

// =============================================================================
// Docker mode commands
// =============================================================================

function dockerStart(dir: string): void {
  const spinner = ora('Starting SlackHive services (Docker)...').start();
  try {
    execSync('docker compose up -d', { cwd: dir, stdio: 'ignore' });
    spinner.succeed('All services started');
    console.log(chalk.gray('  Web UI: http://localhost:3001'));
  } catch {
    spinner.fail('Failed to start services');
  }
}

function dockerStop(dir: string): void {
  const spinner = ora('Stopping SlackHive services (Docker)...').start();
  try {
    execSync('docker compose stop', { cwd: dir, stdio: 'ignore' });
    spinner.succeed('All services stopped');
  } catch {
    spinner.fail('Failed to stop services');
  }
}

function dockerStatus(dir: string): void {
  try {
    const output = execSync('docker compose ps', { cwd: dir, encoding: 'utf-8' });
    console.log('');
    console.log(chalk.bold('  SlackHive Status (Docker)'));
    console.log('');
    console.log(output);
  } catch {
    console.log(chalk.red('  Failed to get status'));
  }
}

function dockerLogs(dir: string, follow: boolean): void {
  const args = ['compose', 'logs', 'runner'];
  if (follow) args.push('-f');
  const proc = spawn('docker', args, { cwd: dir, stdio: 'inherit' });
  proc.on('error', () => console.log(chalk.red('  Failed to tail logs')));
}

function dockerUpdate(dir: string): void {
  const pullSpinner = ora('Pulling latest changes...').start();
  try {
    execSync('git pull', { cwd: dir, stdio: 'ignore' });
    pullSpinner.succeed('Code updated');
  } catch {
    pullSpinner.fail('Failed to pull — do you have uncommitted changes?');
    return;
  }
  const buildSpinner = ora('Rebuilding services (this may take a minute)...').start();
  try {
    execSync('docker compose up -d --build', { cwd: dir, stdio: 'ignore', timeout: 600000 });
    buildSpinner.succeed('Services rebuilt and restarted');
    console.log(chalk.gray('  Web UI: http://localhost:3001'));
  } catch {
    buildSpinner.fail('Failed to rebuild');
  }
}

// =============================================================================
// Native mode commands
// =============================================================================

function nativeStart(dir: string): void {
  const existing = readPidInfo();
  if (existing) {
    // SlackHive already running — stop it first, then restart
    const stopSpinner = ora('Stopping existing instance...').start();
    try { process.kill(-existing.pid, 'SIGTERM'); } catch { /* try individual */ }
    try { process.kill(existing.pid, 'SIGTERM'); } catch { /* already dead */ }
    for (const port of [String(existing.webPort), String(existing.internalPort)]) {
      try { execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' }); } catch { /* clean */ }
    }
    try { unlinkSync(getPidFile()); } catch { /* ignore */ }
    stopSpinner.succeed('Stopped existing instance');
  }

  const spinner = ora('Starting SlackHive (native mode)...').start();

  try {
    // Check if built
    const standaloneJs = join(dir, 'apps', 'runner', 'dist', 'standalone.js');
    if (!existsSync(standaloneJs)) {
      spinner.text = 'Building TypeScript...';
      execSync('npm run build', { cwd: dir, stdio: 'ignore', timeout: 120000 });
    }

    // Find free ports — prefer 3001/3002, auto-pick next free if something else uses them
    const isPortFree = (port: number): boolean => {
      try { execSync(`lsof -ti:${port}`, { stdio: ['pipe', 'pipe', 'pipe'] }); return false; } catch { return true; }
    };
    let webPort = 3001;
    while (!isPortFree(webPort) && webPort < 3100) webPort++;
    let internalPort = 3002;
    while ((!isPortFree(internalPort) || internalPort === webPort) && internalPort < 3100) internalPort++;

    env.PORT = String(webPort);
    env.RUNNER_INTERNAL_PORT = String(internalPort);
    if (webPort !== 3001) console.log(chalk.yellow(`  Port 3001 in use, using ${webPort}`));

    // Build clean env — load from .env but strip stale OAuth tokens
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      USER: process.env.USER ?? '',
      SHELL: process.env.SHELL ?? '',
      TERM: process.env.TERM ?? '',
      DATABASE_TYPE: 'sqlite',
      NODE_ENV: 'production',
    };

    // Load .env file if present
    const envFile = join(dir, '.env');
    if (existsSync(envFile)) {
      const envContent = readFileSync(envFile, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx);
          const val = trimmed.slice(eqIdx + 1);
          // Skip stale OAuth tokens — SDK reads from system Keychain/credentials file
          if (key === 'CLAUDE_CODE_OAUTH_TOKEN' || key === 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN') continue;
          env[key] = val;
        }
      }
    }

    // Ensure DATABASE_TYPE is always sqlite in native mode
    env.DATABASE_TYPE = 'sqlite';

    spinner.text = 'Starting...';
    const child = spawn('node', [standaloneJs], {
      cwd: dir,
      env,
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
    writePid(child.pid!, webPort, internalPort);

    spinner.succeed(`SlackHive started (PID ${child.pid})`);
    console.log(chalk.gray(`  Web UI: http://localhost:${webPort}`));
    console.log(chalk.gray('  Mode:   native (SQLite, no Docker)'));
    console.log(chalk.gray(`  Data:   ${getSlackhiveDir()}/data.db`));
    console.log(chalk.gray(`  Logs:   ${getSlackhiveDir()}/logs/runner.log`));
  } catch (err) {
    spinner.fail(`Failed to start: ${(err as Error).message}`);
  }
}

function nativeStop(): void {
  const info = readPidInfo();
  if (!info) {
    console.log(chalk.yellow('  SlackHive is not running'));
    return;
  }

  const spinner = ora('Stopping SlackHive...').start();
  try {
    try { process.kill(-info.pid, 'SIGTERM'); } catch { /* try individual */ }
    try { process.kill(info.pid, 'SIGTERM'); } catch { /* already dead */ }

    // Clean up the actual ports this instance was using
    for (const port of [String(info.webPort), String(info.internalPort)]) {
      try { execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' }); } catch { /* clean */ }
    }

    try { unlinkSync(getPidFile()); } catch { /* ignore */ }
    spinner.succeed('SlackHive stopped');
  } catch {
    spinner.fail('Failed to stop SlackHive');
  }
}

function nativeStatus(): void {
  const info = readPidInfo();
  console.log('');
  console.log(chalk.bold('  SlackHive Status'));
  console.log('');
  if (info) {
    console.log(chalk.green(`  Status:   Running (PID ${info.pid})`));
    console.log(chalk.gray(`  Web UI:   http://localhost:${info.webPort}`));
    console.log(chalk.gray(`  Database: ${getSlackhiveDir()}/data.db`));
    console.log(chalk.gray(`  Logs:     ${getSlackhiveDir()}/logs/runner.log`));
  } else {
    console.log(chalk.red('  Status:   Stopped'));
    console.log(chalk.gray('  Run `slackhive start` to start'));
  }
  console.log('');
}

function nativeLogs(follow: boolean): void {
  const logFile = join(getSlackhiveDir(), 'logs', 'runner.log');
  if (!existsSync(logFile)) {
    console.log(chalk.yellow('  No log file found. Is SlackHive running?'));
    return;
  }
  const args = follow ? ['-f', logFile] : ['-n', '200', logFile];
  spawn('tail', args, { stdio: 'inherit' });
}

function nativeUpdate(dir: string): void {
  // Stop first
  const info = readPidInfo();
  if (info) {
    const stopSpinner = ora('Stopping SlackHive...').start();
    try { process.kill(info.pid, 'SIGTERM'); } catch { /* already dead */ }
    try { unlinkSync(getPidFile()); } catch { /* ignore */ }
    stopSpinner.succeed('Stopped');
  }

  const pullSpinner = ora('Pulling latest changes...').start();
  try {
    execSync('git pull', { cwd: dir, stdio: 'ignore' });
    pullSpinner.succeed('Code updated');
  } catch {
    pullSpinner.fail('Failed to pull');
    return;
  }

  const buildSpinner = ora('Rebuilding...').start();
  try {
    execSync('npm install && npm run build', { cwd: dir, stdio: 'ignore', timeout: 120000 });
    buildSpinner.succeed('Rebuilt');
  } catch {
    buildSpinner.fail('Build failed');
    return;
  }

  // Restart
  nativeStart(dir);
}

// =============================================================================
// Exported commands (auto-detect mode)
// =============================================================================

export async function start(): Promise<void> {
  const dir = findProjectDir();
  if (useNativeMode(dir)) {
    nativeStart(dir);
  } else {
    dockerStart(dir);
  }
}

export async function stop(): Promise<void> {
  const dir = findProjectDir();
  if (useNativeMode(dir)) {
    nativeStop();
  } else {
    dockerStop(dir);
  }
}

export async function status(): Promise<void> {
  const dir = findProjectDir();
  if (useNativeMode(dir)) {
    nativeStatus();
  } else {
    dockerStatus(dir);
  }
}

export async function logs(opts: { follow?: boolean }): Promise<void> {
  const dir = findProjectDir();
  if (useNativeMode(dir)) {
    nativeLogs(opts.follow !== false);
  } else {
    dockerLogs(dir, opts.follow !== false);
  }
}

export async function update(): Promise<void> {
  const dir = findProjectDir();
  if (useNativeMode(dir)) {
    nativeUpdate(dir);
  } else {
    dockerUpdate(dir);
  }
}
