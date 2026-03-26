/**
 * @fileoverview Management commands — start, stop, status, logs, update.
 *
 * All commands look for docker-compose.yml in the current directory
 * or the `slackhive` subdirectory.
 *
 * @module cli/commands/manage
 */

import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import ora from 'ora';

/**
 * Finds the SlackHive project directory.
 * Checks cwd first, then ./slackhive subdirectory.
 *
 * @returns {string} Path to the project directory.
 */
function findProjectDir(): string {
  if (existsSync(join(process.cwd(), 'docker-compose.yml'))) {
    return process.cwd();
  }
  const sub = join(process.cwd(), 'slackhive');
  if (existsSync(join(sub, 'docker-compose.yml'))) {
    return sub;
  }
  console.log(chalk.red('  Could not find SlackHive project.'));
  console.log(chalk.gray('  Run this command from the SlackHive directory, or run `slackhive init` first.'));
  process.exit(1);
}

/**
 * Start all SlackHive services.
 */
export async function start(): Promise<void> {
  const dir = findProjectDir();
  const spinner = ora('Starting SlackHive services...').start();
  try {
    execSync('docker compose up -d', { cwd: dir, stdio: 'ignore' });
    spinner.succeed('All services started');
    console.log(chalk.gray('  Web UI: http://localhost:3001'));
  } catch {
    spinner.fail('Failed to start services');
  }
}

/**
 * Stop all SlackHive services.
 */
export async function stop(): Promise<void> {
  const dir = findProjectDir();
  const spinner = ora('Stopping SlackHive services...').start();
  try {
    execSync('docker compose stop', { cwd: dir, stdio: 'ignore' });
    spinner.succeed('All services stopped');
  } catch {
    spinner.fail('Failed to stop services');
  }
}

/**
 * Show running SlackHive containers.
 */
export async function status(): Promise<void> {
  const dir = findProjectDir();
  try {
    const output = execSync('docker compose ps', { cwd: dir, encoding: 'utf-8' });
    console.log('');
    console.log(chalk.bold('  SlackHive Status'));
    console.log('');
    console.log(output);
  } catch {
    console.log(chalk.red('  Failed to get status'));
  }
}

/**
 * Tail runner service logs.
 */
export async function logs(opts: { follow?: boolean }): Promise<void> {
  const dir = findProjectDir();
  const args = ['compose', 'logs', 'runner'];
  if (opts.follow !== false) args.push('-f');

  const proc = spawn('docker', args, { cwd: dir, stdio: 'inherit' });
  proc.on('error', () => console.log(chalk.red('  Failed to tail logs')));
}

/**
 * Pull latest changes and rebuild.
 */
export async function update(): Promise<void> {
  const dir = findProjectDir();

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
