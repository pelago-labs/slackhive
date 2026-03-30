/**
 * @fileoverview `slackhive init` — clone, configure, and start SlackHive.
 *
 * @module cli/commands/init
 */

import { execSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';

const REPO_URL = 'https://github.com/amansrivastava17/slackhive.git';

interface InitOptions {
  dir: string;
  skipStart?: boolean;
}

/**
 * Runs `slackhive init` — interactive setup wizard.
 *
 * @param {InitOptions} opts - CLI options.
 */
export async function init(opts: InitOptions): Promise<void> {
  const dir = resolve(opts.dir);

  const O = chalk.hex('#D97757').bold;
  const W = chalk.hex('#EBE6E0').bold;
  console.log('');
  console.log('  ' + W('  │   │  '));
  console.log('  ' + W('──┼───┼──'));
  console.log('  ' + O('>') + W(' │──') + O('█') + W('│  '));
  console.log('  ' + W('  │   │  '));
  console.log('');
  console.log(chalk.bold('  SlackHive') + chalk.gray(' — AI agent teams on Slack'));
  console.log('');

  // ── Check prerequisites ────────────────────────────────────────────────────
  const checks = [
    { name: 'Docker', cmd: 'docker --version' },
    { name: 'Docker Compose', cmd: 'docker compose version' },
    { name: 'Git', cmd: 'git --version' },
  ];

  for (const check of checks) {
    try {
      execSync(check.cmd, { stdio: 'ignore' });
      console.log(chalk.green('  ✓') + ` ${check.name} found`);
    } catch {
      console.log(chalk.red(`  ✗ ${check.name} not found. Please install it first.`));
      process.exit(1);
    }
  }
  console.log('');

  // ── Clone ──────────────────────────────────────────────────────────────────
  if (existsSync(dir)) {
    console.log(chalk.yellow(`  Directory ${opts.dir} already exists. Using existing.`));
  } else {
    const spinner = ora('Cloning SlackHive repository...').start();
    try {
      execSync(`git clone ${REPO_URL} "${dir}"`, { stdio: 'ignore' });
      spinner.succeed('Repository cloned');
    } catch (e) {
      spinner.fail('Failed to clone repository');
      process.exit(1);
    }
  }

  // ── Configure .env ─────────────────────────────────────────────────────────
  const envPath = join(dir, '.env');
  const envExamplePath = join(dir, '.env.example');

  if (!existsSync(envPath) && existsSync(envExamplePath)) {
    console.log('');
    console.log(chalk.bold('  Configure environment:'));
    console.log('');

    // Auth mode selection
    const authMode = await prompts({
      type: 'select',
      name: 'mode',
      message: 'How do you want to authenticate with Claude?',
      choices: [
        { title: 'API Key — pay-per-use via Anthropic API', value: 'apikey' },
        { title: 'Subscription — run `claude login` first', value: 'subscription' },
      ],
    });

    if (!authMode.mode) {
      console.log(chalk.red('\n  Setup cancelled.'));
      process.exit(1);
    }

    const questions: prompts.PromptObject[] = [];

    if (authMode.mode === 'apikey') {
      questions.push({
        type: 'text',
        name: 'anthropicKey',
        message: 'Anthropic API key',
        validate: (v: string) => v.startsWith('sk-') ? true : 'Must start with sk-',
      });
    } else {
      // Check if ~/.claude exists
      const claudeDir = join(process.env.HOME || '~', '.claude');
      if (!existsSync(claudeDir)) {
        console.log(chalk.yellow('\n  ⚠ ~/.claude not found. Run `claude login` first, then re-run `slackhive init`.'));
        process.exit(1);
      }
      console.log(chalk.green('  ✓') + ' Found ~/.claude credentials');
      // Find claude binary
      let claudeBinDefault = '/usr/local/bin/claude';
      try {
        const found = execSync('which claude', { encoding: 'utf-8' }).trim();
        if (found) claudeBinDefault = found;
      } catch { /* use default */ }
      questions.push({
        type: 'text',
        name: 'claudeBin',
        message: 'Path to claude binary',
        initial: claudeBinDefault,
      });
    }

    questions.push(
      {
        type: 'text',
        name: 'adminUsername',
        message: 'Admin username',
        initial: 'admin',
      },
      {
        type: 'password',
        name: 'adminPassword',
        message: 'Admin password',
        validate: (v: string) => v.length >= 6 ? true : 'At least 6 characters',
      },
      {
        type: 'text',
        name: 'postgresPassword',
        message: 'Postgres password',
        initial: randomSecret().slice(0, 16),
      },
      {
        type: 'text',
        name: 'redisPassword',
        message: 'Redis password',
        initial: randomSecret().slice(0, 16),
      },
    );

    const response = await prompts(questions);

    if (authMode.mode === 'apikey' && !response.anthropicKey) {
      console.log(chalk.red('\n  Setup cancelled.'));
      process.exit(1);
    }
    if (!response.adminPassword) {
      console.log(chalk.red('\n  Setup cancelled.'));
      process.exit(1);
    }

    // Build .env from scratch so there are no placeholder values
    let envContent = '# Generated by slackhive init\n\n';
    if (authMode.mode === 'apikey') {
      envContent += `ANTHROPIC_API_KEY=${response.anthropicKey}\n`;
    } else {
      envContent += `# Claude Code subscription — credentials from ~/.claude\n`;
      envContent += `CLAUDE_BIN=${response.claudeBin}\n`;
    }
    envContent += `\nPOSTGRES_DB=slackhive\n`;
    envContent += `POSTGRES_USER=slackhive\n`;
    envContent += `POSTGRES_PASSWORD=${response.postgresPassword}\n`;
    envContent += `\nREDIS_PASSWORD=${response.redisPassword}\n`;
    envContent += `\nADMIN_USERNAME=${response.adminUsername}\n`;
    envContent += `ADMIN_PASSWORD=${response.adminPassword}\n`;
    envContent += `AUTH_SECRET=${randomSecret()}\n`;
    envContent += `\nNODE_ENV=production\n`;

    writeFileSync(envPath, envContent);
    console.log(chalk.green('\n  ✓') + ' .env file created');
  } else if (existsSync(envPath)) {
    console.log(chalk.yellow('  .env already exists, skipping configuration'));
  }

  // ── Start services ─────────────────────────────────────────────────────────
  if (!opts.skipStart) {
    console.log('');
    const spinner = ora('Starting SlackHive services (this may take a few minutes on first run)...').start();
    try {
      execSync('docker compose up -d --build', { cwd: dir, stdio: 'ignore', timeout: 600000 });
      spinner.succeed('All services started');
    } catch {
      spinner.fail('Failed to start services');
      console.log(chalk.gray('  Try running manually: cd ' + opts.dir + ' && docker compose up -d --build'));
      process.exit(1);
    }

    // Wait for web to be ready
    const webSpinner = ora('Waiting for web UI...').start();
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/login | grep -q 200', { stdio: 'ignore' });
        ready = true;
        break;
      } catch {
        await sleep(2000);
      }
    }

    if (ready) {
      webSpinner.succeed('Web UI ready');
    } else {
      webSpinner.warn('Web UI may still be starting — check http://localhost:3001');
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.hex('#D97757').bold('  🐝 SlackHive is ready!'));
  console.log('');
  console.log(`  ${chalk.bold('Web UI:')}        http://localhost:3001`);
  console.log(`  ${chalk.bold('Login:')}         http://localhost:3001/login`);
  console.log(`  ${chalk.bold('Project dir:')}   ${dir}`);
  console.log('');
  console.log(chalk.gray('  Commands:'));
  console.log(chalk.gray('    slackhive start    Start services'));
  console.log(chalk.gray('    slackhive stop     Stop services'));
  console.log(chalk.gray('    slackhive status   Show container status'));
  console.log(chalk.gray('    slackhive logs     Tail runner logs'));
  console.log(chalk.gray('    slackhive update   Pull latest & rebuild'));
  console.log('');
}

function randomSecret(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
