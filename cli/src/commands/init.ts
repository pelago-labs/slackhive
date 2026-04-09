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

const REPO_URL = 'https://github.com/pelago-labs/slackhive.git';

interface InitOptions {
  dir: string;
  skipStart?: boolean;
}

function detectClaudeBin(): string {
  let claudeBin: string;
  try {
    claudeBin = execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('Claude Code not found. Please install Claude Code first.');
  }
  if (!claudeBin) throw new Error('Claude Code not found. Please install Claude Code first.');
  return claudeBin;
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
  console.log('      ' + W('│   │'));
  console.log('   ' + W('───┼───┼───'));
  console.log('  ' + O('>') + W(' ──┼──') + O('█') + W('┼──'));
  console.log('      ' + W('│   │'));
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
    console.log(chalk.yellow(`  note: Directory ${opts.dir} already exists — using existing`));
  } else {
    const spinner = ora('  Cloning repository...').start();
    try {
      execSync(`git clone --depth 1 ${REPO_URL} "${dir}"`, { stdio: 'ignore' });
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
      // Claude subscription mode — detect installation automatically
      const claudeDir = join(process.env.HOME || '~', '.claude');
      if (!existsSync(claudeDir)) {
        console.log(chalk.yellow('\n  warning: ~/.claude not found. Run `claude login` first, then re-run `slackhive init`.'));
        process.exit(1);
      }
      console.log(chalk.green('  ✓') + ' Found ~/.claude credentials');

      // Auto-detect Claude binary
      const spinner = ora('  Detecting Claude installation...').start();
      let claudeBinDefault = '/usr/local/bin/claude';
      try {
        claudeBinDefault = detectClaudeBin();
        spinner.succeed(`Found Claude at ${claudeBinDefault}`);
      } catch (error) {
        spinner.fail('Could not detect Claude installation');
        console.log(chalk.yellow(`  ${error}`));
        console.log(chalk.gray('  Please provide the path manually:'));
      }

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
    envContent += `ENV_SECRET_KEY=${randomSecret()}\n`;
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
    if (!envContents.includes('ENV_SECRET_KEY=')) missingKeys.push('ENV_SECRET_KEY');
    if (missingKeys.length > 0) {
      console.log(chalk.yellow(`  warning: .env is missing: ${missingKeys.join(', ')} — patching...`));
      let patch = '';
      if (!envContents.includes('REDIS_PASSWORD=')) patch += `\nREDIS_PASSWORD=${randomSecret().slice(0, 16)}\n`;
      if (!envContents.includes('AUTH_SECRET=')) patch += `AUTH_SECRET=${randomSecret()}\n`;
      if (!envContents.includes('ENV_SECRET_KEY=')) patch += `ENV_SECRET_KEY=${randomSecret()}\n`;
      require('fs').appendFileSync(envPath, patch);
      console.log(chalk.green('  ✓') + ' .env patched');
    } else {
      console.log(chalk.yellow('  note: .env already exists — skipping configuration'));
    }
    console.log('');
  }

  // ── Step 4: Build & start ─────────────────────────────────────────────────
  let webReady = true;
  if (!opts.skipStart) {
    console.log(chalk.bold.hex('#D97757')('  [4/4]') + chalk.bold(' Building & starting services'));
    console.log(chalk.gray('  This takes 3–5 minutes on first run while Docker builds images.'));
    console.log('');

    // Pre-flight: check Docker has enough disk space (need ~3GB)
    try {
      const dfOut = execSync('docker system df --format "{{.Size}}"', { encoding: 'utf-8' });
      void dfOut; // just checking it runs without error
    } catch {
      console.log(chalk.yellow('  note: Could not check Docker disk usage — continuing anyway'));
    }

    // Pre-flight: warn if low disk space on host
    try {
      const df = execSync('df -k . | tail -1', { encoding: 'utf-8' }).trim();
      const available = parseInt(df.split(/\s+/)[3]);
      if (!isNaN(available) && available < 3 * 1024 * 1024) {
        console.log(chalk.yellow(`  warning: less than 3GB disk space available. Build may fail.`));
        console.log('');
      }
    } catch { /* non-fatal */ }

    const buildOk = await runDockerBuild(dir, opts.dir);

    if (buildOk) {
      // If containers didn't come up during build, retry once silently
      try {
        execSync('docker compose up -d', { cwd: dir, stdio: 'ignore' });
      } catch { /* non-fatal */ }

      // Wait for web UI — up to 3 minutes
      const webSpinner = ora('  Waiting for web UI to be ready...').start();
      let ready = false;
      for (let i = 0; i < 60; i++) {
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
        webReady = false;
        webSpinner.stopAndPersist({ symbol: ' ' });
      }
    } else {
      webReady = false;
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log('');
  if (webReady) {
    console.log('  ' + chalk.bgHex('#D97757').black.bold('  SlackHive is ready!  '));
    console.log('');
    console.log(`  ${chalk.bold('Open:')}   ${chalk.cyan('http://localhost:3001')}`);
  } else {
    console.log('  ' + chalk.bold('Setup complete!'));
    console.log('');
    console.log(chalk.gray('  Services are still starting. Once ready:'));
    console.log(`  ${chalk.bold('Run:')}    ${chalk.cyan('slackhive start')}`);
    console.log(`  ${chalk.bold('Open:')}   ${chalk.cyan('http://localhost:3001')}`);
  }
  console.log(`  ${chalk.bold('Dir:')}    ${chalk.gray(dir)}`);
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
 * Runs `docker compose up -d --build`.
 * Shows a single updating spinner line with the current build step.
 * Docker's raw progress output is suppressed to keep the terminal clean.
 */
function runDockerBuild(cwd: string, displayDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['compose', '--progress', 'plain', 'up', '-d', '--build'], {
      cwd,
      env: { ...process.env },
    });

    const startTime = Date.now();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIdx = 0;

    // Phased progress tracking
    const phases = [
      { name: 'Installing system packages', weight: 10, pattern: /apk add|fetch.*APKINDEX/i },
      { name: 'Installing npm dependencies', weight: 30, pattern: /npm ci|npm install|added \d+ packages/i },
      { name: 'Compiling TypeScript',        weight: 10, pattern: /tsc|--skipLibCheck/i },
      { name: 'Building web app',            weight: 30, pattern: /next build|next\.config/i },
      { name: 'Creating containers',         weight: 10, pattern: /exporting to image|naming to|exporting layers/i },
      { name: 'Starting services',           weight: 10, pattern: /Container .*(Starting|Started|Healthy|Created)/i },
    ];
    let currentPhase = 0;
    let phaseStartTime = Date.now();

    function getProgress(): number {
      let pct = 0;
      for (let i = 0; i < currentPhase; i++) pct += phases[i].weight;
      // Add partial progress within current phase
      if (currentPhase < phases.length) {
        const elapsed = (Date.now() - phaseStartTime) / 1000;
        const estimatedDuration = currentPhase === 1 ? 90 : currentPhase === 3 ? 100 : 30;
        const partial = Math.min(0.9, elapsed / estimatedDuration);
        pct += phases[currentPhase].weight * partial;
      }
      return Math.min(99, Math.round(pct));
    }

    function renderBar(): string {
      const pct = getProgress();
      const cols = process.stdout.columns || 80;
      const barWidth = Math.min(20, Math.max(10, cols - 55));
      const filled = Math.round((pct / 100) * barWidth);
      const empty = barWidth - filled;
      const bar = chalk.hex('#D97757')('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const phaseName = currentPhase < phases.length ? phases[currentPhase].name : 'Finishing';
      const frame = frames[frameIdx++ % frames.length];
      const pctStr = String(pct).padStart(2);
      return `  ${chalk.hex('#D97757')(frame)} ${bar} ${chalk.bold(pctStr + '%')} ${phaseName} ${chalk.gray('(' + elapsed + 's)')}`;
    }

    const spinnerInterval = setInterval(() => {
      process.stdout.write(`\r\x1b[K${renderBar()}`);
    }, 80);

    let buf = '';
    const errorLines: string[] = [];

    const onData = (chunk: Buffer) => {
      buf += chunk.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        // Check if we've entered a new phase
        for (let i = currentPhase + 1; i < phases.length; i++) {
          if (phases[i].pattern.test(line)) {
            // Print completed phases
            const elapsed = Math.floor((Date.now() - phaseStartTime) / 1000);
            process.stdout.write('\r\x1b[K');
            console.log('  ' + chalk.green('✓') + ' ' + phases[currentPhase].name + chalk.gray(` (${elapsed}s)`));
            // Skip intermediate phases
            for (let j = currentPhase + 1; j < i; j++) {
              console.log('  ' + chalk.green('✓') + ' ' + phases[j].name + chalk.gray(' (cached)'));
            }
            currentPhase = i;
            phaseStartTime = Date.now();
            break;
          }
        }

        if (/error/i.test(line)) errorLines.push(line);
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('close', (code) => {
      clearInterval(spinnerInterval);
      process.stdout.write('\r\x1b[K');

      if (code === 0) {
        // Print any remaining phases as done
        const elapsed = Math.floor((Date.now() - phaseStartTime) / 1000);
        if (currentPhase < phases.length) {
          console.log('  ' + chalk.green('✓') + ' ' + phases[currentPhase].name + chalk.gray(` (${elapsed}s)`));
          for (let j = currentPhase + 1; j < phases.length; j++) {
            console.log('  ' + chalk.green('✓') + ' ' + phases[j].name);
          }
        }
        console.log('');
        console.log('  ' + chalk.green('✓') + chalk.bold(' All services started'));
        resolve(true);
        return;
      }

      console.log('  ' + chalk.red('✗') + ' Failed to start services');
      console.log('');

      const allErrors = errorLines.join('\n').toLowerCase();
      if (allErrors.includes('no space left') || allErrors.includes('disk full')) {
        console.log(chalk.yellow('  Cause: Docker is out of disk space.'));
        console.log(chalk.gray('  Fix:   docker system prune -a'));
      } else if (allErrors.includes('port is already allocated') || allErrors.includes('address already in use')) {
        const portMatch = /bind for .+:(\d+)/.exec(allErrors);
        const port = portMatch ? portMatch[1] : 'a required port';
        console.log(chalk.yellow(`  Cause: Port ${port} is already in use.`));
        console.log(chalk.gray(`  Fix:   stop the process on port ${port} and retry`));
      } else if (allErrors.includes('permission denied') || allErrors.includes('unauthorized')) {
        console.log(chalk.yellow('  Cause: Docker permission denied — is Docker Desktop running?'));
      } else if (allErrors.includes('memory') || allErrors.includes('oom')) {
        console.log(chalk.yellow('  Cause: Docker ran out of memory.'));
        console.log(chalk.gray('  Fix:   increase Docker Desktop memory to 4GB+ in Settings → Resources'));
      } else if (allErrors.includes('network') || allErrors.includes('timeout') || allErrors.includes('pull') || allErrors.includes('tls') || allErrors.includes('certificate')) {
        console.log(chalk.yellow('  Cause: Network/TLS error — try restarting Docker Desktop.'));
      } else if (errorLines.length > 0) {
        console.log(chalk.gray('  Error details:'));
        errorLines.slice(-5).forEach(l => console.log(chalk.red('    ' + l)));
      }

      console.log('');
      console.log(chalk.gray(`  To retry: cd ${displayDir} && docker compose up -d --build`));
      resolve(false);
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
