/**
 * @fileoverview Management commands — start, stop, status, logs, update.
 *
 * Runs SlackHive as a native Node.js process with SQLite.
 *
 * @module cli/commands/manage
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import ora from 'ora';

// =============================================================================
// Project & mode detection
// =============================================================================

function getConfigPath(): string {
  return join(getSlackhiveDir(), 'config.json');
}

function saveProjectDir(dir: string): void {
  const configPath = getConfigPath();
  mkdirSync(join(configPath, '..'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ projectDir: dir }));
}

function findProjectDir(): string {
  const isSlackHiveDir = (d: string) => existsSync(join(d, 'package.json')) && existsSync(join(d, 'apps', 'runner'));

  // 1. Check current directory
  if (isSlackHiveDir(process.cwd())) {
    const dir = process.cwd();
    saveProjectDir(dir);
    return dir;
  }
  // 2. Check ./slackhive subdirectory
  const sub = join(process.cwd(), 'slackhive');
  if (isSlackHiveDir(sub)) {
    saveProjectDir(sub);
    return sub;
  }
  // 3. Read saved project path from config
  try {
    const config = JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
    if (config.projectDir && existsSync(join(config.projectDir, 'apps', 'runner'))) {
      return config.projectDir;
    }
  } catch { /* no saved config */ }

  console.log(chalk.red('  Could not find SlackHive project.'));
  console.log(chalk.gray('  Run this command from the SlackHive directory, or run `slackhive init` first.'));
  process.exit(1);
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

  const spinner = ora('Starting SlackHive...').start();

  try {
    // Run from source via tsx — the claude-agent-sdk is ESM-only and breaks
    // CommonJS-compiled dist output (ERR_REQUIRE_ESM). tsx transpiles on the
    // fly and handles the ESM/CJS interop transparently.
    const standaloneTs = join(dir, 'apps', 'runner', 'src', 'standalone.ts');
    const tsxBin = join(dir, 'node_modules', '.bin', 'tsx');
    if (!existsSync(standaloneTs)) {
      spinner.fail('standalone.ts not found — is this a valid SlackHive repo?');
      return;
    }
    if (!existsSync(tsxBin)) {
      spinner.text = 'Installing dependencies...';
      execSync('npm install', { cwd: dir, stdio: 'ignore', timeout: 300000 });
    }

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

    // Ensure DATABASE_TYPE is always sqlite
    env.DATABASE_TYPE = 'sqlite';

    // Find free ports
    const isPortFree = (port: number): boolean => {
      try { execSync(`lsof -ti:${port}`, { stdio: ['pipe', 'pipe', 'pipe'] }); return false; } catch { return true; }
    };
    let webPort = 3001;
    while (!isPortFree(webPort) && webPort < 3100) webPort++;
    if (!isPortFree(webPort)) {
      spinner.fail('No free port in range 3001–3099 for web UI');
      return;
    }
    let internalPort = 3002;
    while ((!isPortFree(internalPort) || internalPort === webPort) && internalPort < 3100) internalPort++;
    if (!isPortFree(internalPort) || internalPort === webPort) {
      spinner.fail('No free port in range 3002–3099 for internal runner');
      return;
    }
    env.PORT = String(webPort);
    env.RUNNER_INTERNAL_PORT = String(internalPort);
    if (webPort !== 3001) console.log(chalk.yellow(`  Port 3001 in use, using ${webPort}`));

    spinner.text = 'Starting...';
    // Use a log file for detached output so users can see crashes via `slackhive logs`
    const logDir = join(process.env.HOME ?? '/tmp', '.slackhive', 'logs');
    mkdirSync(logDir, { recursive: true });
    const out = openSync(join(logDir, 'native-stdout.log'), 'a');
    const err = openSync(join(logDir, 'native-stderr.log'), 'a');

    const child = spawn(tsxBin, [standaloneTs], {
      cwd: dir,
      env,
      detached: true,
      stdio: ['ignore', out, err],
    });

    child.unref();
    writePid(child.pid!, webPort, internalPort);

    spinner.succeed(`SlackHive started (PID ${child.pid})`);
    console.log(chalk.gray(`  Web UI: http://localhost:${webPort}`));
    console.log(chalk.gray(`  Data:   ${getSlackhiveDir()}/data.db`));
    console.log(chalk.gray(`  Logs:   ${getSlackhiveDir()}/logs/runner.log`));
  } catch (err) {
    spinner.fail(`Failed to start: ${(err as Error).message}`);
  }
}

/**
 * Find stray runner processes NOT managed by this CLI's PID file. Covers
 * orphaned `tsx watch src/index.ts` from `npm run dev` sessions and any
 * direct `node apps/runner/dist/standalone.js` invocations.
 *
 * The PID file tracks only one process group at a time; parallel dev runners
 * from prior shells stay invisible to it and keep racing on the DB. This
 * scan closes that gap — see the runner-lock module for the prevention side.
 */
function findOrphanRunnerPids(excludePid: number | null): number[] {
  try {
    const out = execSync('ps -e -o pid,command', { encoding: 'utf-8' });
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmd = m[2];
      if (pid === process.pid) continue;
      if (excludePid !== null && pid === excludePid) continue;
      // Runner entrypoints — two node scripts and the tsx watch wrapper.
      if (
        cmd.includes('apps/runner/dist/standalone.js') ||
        /tsx.*apps\/runner\/src\/index\.ts/.test(cmd) ||
        /tsx watch src\/index\.ts/.test(cmd)
      ) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

function killOrphans(excludePid: number | null): number {
  const pids = findOrphanRunnerPids(excludePid);
  if (pids.length === 0) return 0;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }
  // Give SIGTERM a moment, then SIGKILL any stragglers.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const alive = pids.filter(pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (alive.length === 0) return pids.length;
    try { execSync('sleep 0.2'); } catch { /* ignore */ }
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
  return pids.length;
}

function nativeStop(): void {
  const info = readPidInfo();
  const spinner = ora('Stopping SlackHive...').start();
  try {
    if (info) {
      try { process.kill(-info.pid, 'SIGTERM'); } catch { /* try individual */ }
      try { process.kill(info.pid, 'SIGTERM'); } catch { /* already dead */ }

      // Clean up the actual ports this instance was using
      for (const port of [String(info.webPort), String(info.internalPort)]) {
        try { execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' }); } catch { /* clean */ }
      }

      try { unlinkSync(getPidFile()); } catch { /* ignore */ }
    }

    // Always sweep orphans too — `stop` means "stop everything slackhive-ish",
    // not "stop only the thing my PID file happens to know about". Catches
    // stray `tsx watch` / direct standalone.js runs from prior sessions.
    const killed = killOrphans(info?.pid ?? null);

    // Remove the runner lock file unconditionally so a crashed previous
    // runner doesn't block the next `slackhive start`.
    try { unlinkSync(join(getSlackhiveDir(), 'runner.lock')); } catch { /* ignore */ }

    if (!info && killed === 0) {
      spinner.info('SlackHive was not running');
      return;
    }
    const extra = killed > 0 ? ` (killed ${killed} orphaned runner process${killed === 1 ? '' : 'es'})` : '';
    spinner.succeed(`SlackHive stopped${extra}`);
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
  // Tail the winston runner.log (structured agent events) plus the stdout/stderr
  // streams from the detached process (for crashes and MCP script errors that
  // never reach winston).
  const logDir = join(getSlackhiveDir(), 'logs');
  const files = ['runner.log', 'native-stdout.log', 'native-stderr.log']
    .map(f => join(logDir, f))
    .filter(f => existsSync(f));
  if (files.length === 0) {
    console.log(chalk.yellow('  No log files found. Is SlackHive running?'));
    return;
  }
  const args = follow ? ['-f', ...files] : ['-n', '200', ...files];
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

  // Detect whether the project dir is a git repo
  const isGitRepo = existsSync(join(dir, '.git'));

  if (!isGitRepo) {
    console.log(chalk.yellow('  This installation was not set up via git.'));
    console.log(chalk.gray('  To update, run: ') + chalk.white('npm update -g slackhive'));
    return;
  }

  const pullSpinner = ora('Pulling latest changes...').start();
  try {
    const output = execSync('git pull 2>&1', { cwd: dir, encoding: 'utf-8' });
    if (output.includes('Already up to date')) {
      pullSpinner.succeed('Already up to date');
    } else {
      pullSpinner.succeed('Code updated');
    }
  } catch (err) {
    const msg = (err as { stdout?: string; stderr?: string }).stdout ?? (err as { stderr?: string }).stderr ?? '';
    pullSpinner.fail('Failed to pull');
    if (msg) console.log(chalk.gray('  ' + msg.trim().split('\n')[0]));
    console.log(chalk.gray('  Tip: if you have local changes, run ') + chalk.white('git stash') + chalk.gray(' first, then retry.'));
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
  nativeStart(findProjectDir());
}

export async function stop(): Promise<void> {
  nativeStop();
}

export async function status(): Promise<void> {
  nativeStatus();
}

export async function logs(opts: { follow?: boolean }): Promise<void> {
  nativeLogs(opts.follow !== false);
}

export async function update(): Promise<void> {
  nativeUpdate(findProjectDir());
}
