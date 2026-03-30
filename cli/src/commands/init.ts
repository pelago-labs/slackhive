/**
 * @fileoverview `slackhive init` — clone, configure, and start SlackHive.
 *
 * @module cli/commands/init
 */

import { execSync, spawn } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
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

  // ── Step 1: Check prerequisites ───────────────────────────────────────────
  console.log(chalk.bold.hex('#D97757')('  [1/4]') + chalk.bold(' Checking prerequisites'));
  console.log('');

  const checks = [
    { name: 'Docker daemon', cmd: 'docker info', errMsg: 'Docker is not running. Please start Docker Desktop and try again.' },
    { name: 'Docker Compose', cmd: 'docker compose version', errMsg: 'Docker Compose not found. Please install Docker Desktop.' },
    { name: 'Git', cmd: 'git --version', errMsg: 'Git not found. Please install Git first.' },
  ];

  for (const check of checks) {
    const spinner = ora(`  Checking ${check.name}...`).start();
    try {
      execSync(check.cmd, { stdio: 'ignore' });
      spinner.succeed(chalk.green(`${check.name} ready`));
    } catch {
      spinner.fail(chalk.red(`${check.name}: ${check.errMsg}`));
      process.exit(1);
    }
  }
  console.log('');

  // ── Step 2: Clone ─────────────────────────────────────────────────────────
  console.log(chalk.bold.hex('#D97757')('  [2/4]') + chalk.bold(' Getting SlackHive'));
  console.log('');

  if (existsSync(dir)) {
    console.log(chalk.yellow(`  ↳ Directory ${opts.dir} already exists — using existing`));
  } else {
    const spinner = ora('  Cloning repository...').start();
    try {
      execSync(`git clone ${REPO_URL} "${dir}"`, { stdio: 'ignore' });
      spinner.succeed('Repository cloned');
    } catch {
      spinner.fail('Failed to clone repository');
      process.exit(1);
    }
  }
  console.log('');

  // ── Step 3: Configure .env ────────────────────────────────────────────────
  const envPath = join(dir, '.env');

  if (!existsSync(envPath)) {
    console.log(chalk.bold.hex('#D97757')('  [3/4]') + chalk.bold(' Configure environment'));
    console.log('');

    const authMode = await prompts({
      type: 'select',
      name: 'mode',
      message: 'Claude authentication',
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
      const claudeDir = join(process.env.HOME || '~', '.claude');
      if (!existsSync(claudeDir)) {
        console.log(chalk.yellow('\n  ⚠ ~/.claude not found. Run `claude login` first, then re-run `slackhive init`.'));
        process.exit(1);
      }
      console.log(chalk.green('  ✓') + ' Found ~/.claude credentials');
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
      { type: 'text', name: 'adminUsername', message: 'Admin username', initial: 'admin' },
      { type: 'password', name: 'adminPassword', message: 'Admin password', validate: (v: string) => v.length >= 6 ? true : 'At least 6 characters' },
      { type: 'text', name: 'postgresPassword', message: 'Postgres password', initial: randomSecret().slice(0, 16) },
      { type: 'text', name: 'redisPassword', message: 'Redis password', initial: randomSecret().slice(0, 16) },
    );

    const response = await prompts(questions);

    if (!response.adminPassword) {
      console.log(chalk.red('\n  Setup cancelled.'));
      process.exit(1);
    }

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
    console.log('');
    console.log(chalk.green('  ✓') + ' .env file created');
    console.log('');
  } else {
    console.log(chalk.bold.hex('#D97757')('  [3/4]') + chalk.bold(' Configure environment'));
    console.log('');
    // Check if existing .env is missing required keys
    const envContents = existsSync(envPath) ? require('fs').readFileSync(envPath, 'utf-8') : '';
    const missingKeys: string[] = [];
    if (!envContents.includes('REDIS_PASSWORD=')) missingKeys.push('REDIS_PASSWORD');
    if (!envContents.includes('AUTH_SECRET=')) missingKeys.push('AUTH_SECRET');
    if (missingKeys.length > 0) {
      console.log(chalk.yellow(`  ⚠ .env is missing: ${missingKeys.join(', ')} — patching...`));
      let patch = '';
      if (!envContents.includes('REDIS_PASSWORD=')) patch += `\nREDIS_PASSWORD=${randomSecret().slice(0, 16)}\n`;
      if (!envContents.includes('AUTH_SECRET=')) patch += `AUTH_SECRET=${randomSecret()}\n`;
      require('fs').appendFileSync(envPath, patch);
      console.log(chalk.green('  ✓') + ' .env patched');
    } else {
      console.log(chalk.yellow('  ↳ .env already exists — skipping configuration'));
    }
    console.log('');
  }

  // ── Step 4: Build & start ─────────────────────────────────────────────────
  if (!opts.skipStart) {
    console.log(chalk.bold.hex('#D97757')('  [4/4]') + chalk.bold(' Building & starting services'));
    console.log(chalk.gray('  This takes 3–5 minutes on first run while Docker builds images.'));
    console.log('');

    await runDockerBuild(dir, opts.dir);

    // Wait for web UI
    const webSpinner = ora('  Waiting for web UI to be ready...').start();
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        execSync('curl -sf http://localhost:3001/login', { stdio: 'ignore' });
        ready = true;
        break;
      } catch {
        await sleep(3000);
      }
    }
    if (ready) {
      webSpinner.succeed('Web UI is ready');
    } else {
      webSpinner.warn('Web UI may still be starting up');
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log('');
  console.log('  ' + chalk.bgHex('#D97757').black.bold('  SlackHive is ready!  '));
  console.log('');
  console.log(`  ${chalk.bold('→ Open:')}   ${chalk.cyan('http://localhost:3001')}`);
  console.log(`  ${chalk.bold('→ Dir:')}    ${chalk.gray(dir)}`);
  console.log('');
  console.log(chalk.gray('  Useful commands:'));
  console.log(chalk.gray('    slackhive start    — Start services'));
  console.log(chalk.gray('    slackhive stop     — Stop services'));
  console.log(chalk.gray('    slackhive status   — Show container status'));
  console.log(chalk.gray('    slackhive logs     — Tail runner logs'));
  console.log(chalk.gray('    slackhive update   — Pull latest & rebuild'));
  console.log('');
}

/**
 * Runs `docker compose up -d --build` with live streaming progress output.
 * Shows each build step as it happens instead of a silent spinner.
 *
 * @param {string} cwd - The project directory.
 * @param {string} displayDir - Display name for error message.
 * @returns {Promise<void>}
 */
function runDockerBuild(cwd: string, displayDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['compose', 'up', '-d', '--build'], {
      cwd,
      env: { ...process.env },
    });

    const stepPattern = /^#\d+ \[([^\]]+)\] (.+)/;
    const donePattern = /^\s*(✔|Container .+ (Started|Running|Healthy)|Image .+ Built)/i;

    let lastStep = '';

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') && trimmed.includes('CACHED')) return;

      const stepMatch = stepPattern.exec(trimmed);
      if (stepMatch) {
        const label = `  ${chalk.gray('▸')} ${chalk.dim(stepMatch[1])} ${stepMatch[2]}`;
        if (label !== lastStep) {
          process.stdout.write('\r\x1b[K' + label.slice(0, process.stdout.columns - 2));
          lastStep = label;
        }
        return;
      }

      if (donePattern.test(trimmed)) {
        process.stdout.write('\r\x1b[K');
        console.log('  ' + chalk.green('✓') + ' ' + trimmed.replace(/^✔\s*/, '').replace(/Container /, ''));
      }
    };

    const startTime = Date.now();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIdx = 0;
    let currentStep = 'Building images';
    const fallbackInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const frame = frames[frameIdx++ % frames.length];
      process.stdout.write(`\r\x1b[K  ${chalk.hex('#D97757')(frame)} ${currentStep} ${chalk.gray(elapsed + 's')}`);
    }, 80);

    let stdoutBuf = '';
    let stderrBuf = '';
    const errorLines: string[] = [];

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      lines.forEach(line => {
        processLine(line);
        // Update current step label from build output
        const m = /\[([^\]]+)\] (.+)/.exec(line.trim());
        if (m) currentStep = `${m[1]} — ${m[2].slice(0, 40)}`;
      });
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      lines.forEach(line => {
        processLine(line);
        const m = /\[([^\]]+)\] (.+)/.exec(line.trim());
        if (m) currentStep = `${m[1]} — ${m[2].slice(0, 40)}`;
        if (/error/i.test(line) && line.trim()) errorLines.push(line.trim());
      });
    });

    proc.on('close', (code) => {
      clearInterval(fallbackInterval);
      process.stdout.write('\r\x1b[K');
      if (code === 0) {
        console.log('  ' + chalk.green('✓') + ' All services started');
        resolve();
      } else {
        console.log('  ' + chalk.red('✗') + ' Failed to start services');
        if (errorLines.length > 0) {
          console.log('');
          console.log(chalk.gray('  Error details:'));
          errorLines.slice(-5).forEach(l => console.log(chalk.red('  ' + l)));
        }
        console.log('');
        console.log(chalk.gray(`  To retry: cd ${displayDir} && docker compose up -d --build`));
        resolve(); // don't reject — let init finish gracefully
      }
    });
  });
}

function randomSecret(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
