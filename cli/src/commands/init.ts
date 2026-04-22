/**
 * @fileoverview `slackhive init` — clone, configure, and start SlackHive.
 *
 * @module cli/commands/init
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
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

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
}

/**
 * Parses a JSON credential blob and extracts OAuth tokens.
 */
export function parseOAuthFromJson(json: string): OAuthCredentials | null {
  try {
    const parsed = JSON.parse(json);
    const oauth = parsed?.claudeAiOauth;
    if (oauth?.accessToken && oauth?.refreshToken) {
      return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken };
    }
  } catch { /* invalid json */ }
  return null;
}

/**
 * Extracts the OAuth credentials from the OS credential store.
 * Tries macOS Keychain, then Linux secret-tool (GNOME Keyring).
 * Returns access + refresh tokens, or null if not found.
 */
export function extractOAuthCredentials(): OAuthCredentials | null {
  // macOS: read from Keychain
  try {
    const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const result = parseOAuthFromJson(creds);
    if (result) return result;
  } catch { /* not macOS or not found */ }

  // Linux: try secret-tool (GNOME Keyring)
  try {
    const creds = execSync('secret-tool lookup service "Claude Code-credentials"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const result = parseOAuthFromJson(creds);
    if (result) return result;
  } catch { /* not available */ }

  // Fallback: read credentials file directly (headless Linux / no keyring)
  try {
    const credPath = join(process.env.HOME || '~', '.claude', '.credentials.json');
    if (existsSync(credPath)) {
      const creds = readFileSync(credPath, 'utf-8').trim();
      const result = parseOAuthFromJson(creds);
      if (result) return result;
    }
  } catch { /* file not readable or invalid */ }

  return null;
}

/**
 * Writes OAuth credentials to ~/.claude/.credentials.json so subscription
 * mode can access them. On Linux this file is created natively by
 * `claude login`; on macOS credentials go to Keychain instead, so we
 * need to create the file explicitly.
 */
export function syncCredentialsFile(creds: OAuthCredentials): void {
  const credPath = join(process.env.HOME || '~', '.claude', '.credentials.json');
  const payload = JSON.stringify({
    claudeAiOauth: {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
    },
  }, null, 2);
  writeFileSync(credPath, payload, { mode: 0o600 });
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

  const needsClone = !existsSync(dir);
  const checks = [
    { name: 'Node.js', cmd: 'node --version', errMsg: 'Node.js not found. Please install Node.js 20+ first.' },
    ...(needsClone ? [{ name: 'Git', cmd: 'git --version', errMsg: 'Git not found. Install Git or download SlackHive manually.' }] : []),
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
  const freshEnv = !existsSync(envPath);

  if (freshEnv) {
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
    let oauthCreds: OAuthCredentials | null = null;

    if (authMode.mode === 'apikey') {
      questions.push({
        type: 'text',
        name: 'anthropicKey',
        message: 'Anthropic API key',
        validate: (v: string) => v.startsWith('sk-') ? true : 'Must start with sk-',
      });
    } else {
      // Claude subscription mode — extract OAuth token
      const claudeDir = join(process.env.HOME || '~', '.claude');
      if (!existsSync(claudeDir)) {
        console.log(chalk.yellow('\n  warning: ~/.claude not found. Run `claude login` first, then re-run `slackhive init`.'));
        process.exit(1);
      }
      console.log(chalk.green('  ✓') + ' Found ~/.claude credentials');

      const spinner = ora('  Extracting OAuth credentials...').start();
      oauthCreds = extractOAuthCredentials();
      if (oauthCreds) {
        spinner.succeed('OAuth credentials extracted');
        syncCredentialsFile(oauthCreds);
      } else {
        spinner.warn('Could not auto-extract credentials from keychain');
        console.log(chalk.gray('  On Linux/headless servers, paste your OAuth token manually.'));
        console.log(chalk.gray('  Get it from a machine where you ran `claude login`:'));
        console.log(chalk.gray('    security find-generic-password -s "Claude Code-credentials" -w'));
        console.log('');

        const tokenResponse = await prompts([
          { type: 'password', name: 'accessToken', message: 'OAuth access token (sk-ant-oat01-...)', validate: (v: string) => v.startsWith('sk-ant-oat') ? true : 'Must start with sk-ant-oat' },
          { type: 'password', name: 'refreshToken', message: 'OAuth refresh token (sk-ant-ort01-...)', validate: (v: string) => v.startsWith('sk-ant-ort') ? true : 'Must start with sk-ant-ort' },
        ]);
        if (!tokenResponse.accessToken || !tokenResponse.refreshToken) {
          console.log(chalk.red('\n  Setup cancelled. Use API Key mode instead on headless servers.'));
          process.exit(1);
        }
        oauthCreds = { accessToken: tokenResponse.accessToken, refreshToken: tokenResponse.refreshToken };
        syncCredentialsFile(oauthCreds);
      }
    }

    questions.push(
      { type: 'text', name: 'adminUsername', message: 'Admin username', initial: 'admin' },
      { type: 'password', name: 'adminPassword', message: 'Admin password', validate: (v: string) => v.length >= 6 ? true : 'At least 6 characters' },
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
      // Native mode: SDK reads from system directly (Keychain/credentials file)
      envContent += `# Claude Code subscription — auth handled by system (claude login)\n`;
    }

    envContent += `\n# SQLite, no Docker required\n`;
    envContent += `DATABASE_TYPE=sqlite\n`;

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
    let envContents = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
    const missingKeys: string[] = [];
    if (!envContents.includes('AUTH_SECRET=')) missingKeys.push('AUTH_SECRET');
    if (!envContents.includes('ENV_SECRET_KEY=')) missingKeys.push('ENV_SECRET_KEY');
    if (missingKeys.length > 0) {
      console.log(chalk.yellow(`  warning: .env is missing: ${missingKeys.join(', ')} — patching...`));
      let patch = '';
      if (!envContents.includes('AUTH_SECRET=')) patch += `AUTH_SECRET=${randomSecret()}\n`;
      if (!envContents.includes('ENV_SECRET_KEY=')) patch += `ENV_SECRET_KEY=${randomSecret()}\n`;
      require('fs').appendFileSync(envPath, patch);
      envContents = readFileSync(envPath, 'utf-8');
      console.log(chalk.green('  ✓') + ' .env patched');
    }

    // Resync OAuth credentials if using subscription mode
    if (envContents.includes('CLAUDE_CODE_OAUTH_TOKEN=')) {
      const spinner = ora('  Syncing OAuth credentials...').start();
      const freshCreds = extractOAuthCredentials();
      if (freshCreds) {
        // Update .env with fresh tokens
        envContents = envContents
          .replace(/CLAUDE_CODE_OAUTH_TOKEN=.*/, `CLAUDE_CODE_OAUTH_TOKEN=${freshCreds.accessToken}`)
          .replace(/CLAUDE_CODE_OAUTH_REFRESH_TOKEN=.*/, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN=${freshCreds.refreshToken}`);
        writeFileSync(envPath, envContents);
        syncCredentialsFile(freshCreds);
        spinner.succeed('OAuth credentials synced');
      } else {
        spinner.warn('Could not extract credentials — run `claude login` if agents fail to authenticate');
      }
    } else {
      console.log(chalk.yellow('  note: .env already exists — skipping configuration'));
    }
    console.log('');
  }

  // ── Step 4: Build & start ─────────────────────────────────────────────────
  let webReady = true;
  if (!opts.skipStart) {
    console.log(chalk.bold.hex('#D97757')('  [4/4]') + chalk.bold(' Installing & starting'));
    console.log(chalk.gray('  Installing dependencies and building TypeScript...'));
    console.log('');

    // Create native mode marker file
    writeFileSync(join(dir, '.slackhive-native'), 'native');

    const installSpinner = ora('  Installing npm dependencies...').start();
    try {
      execSync('npm install', { cwd: dir, stdio: 'ignore', timeout: 180000 });
      installSpinner.succeed('Dependencies installed');
    } catch (err) {
      installSpinner.fail('npm install failed');
      console.log(chalk.red(`  ${(err as Error).message}`));
      webReady = false;
    }

    if (webReady) {
      const buildSpinner = ora('  Building TypeScript...').start();
      try {
        execSync('npm run build -w packages/shared -w cli && npx tsc --project apps/runner/tsconfig.json --skipLibCheck', { cwd: dir, stdio: 'ignore', timeout: 120000 });
        buildSpinner.succeed('Build complete');
      } catch (err) {
        buildSpinner.fail('Build failed');
        console.log(chalk.red(`  ${(err as Error).message}`));
        webReady = false;
      }
    }

    if (webReady) {
      // Build Next.js
      const nextSpinner = ora('  Building Next.js web app...').start();
      try {
        // Load env vars for the Next.js build
        const envPath = join(dir, '.env');
        const envVars: Record<string, string> = { ...process.env as Record<string, string> };
        if (existsSync(envPath)) {
          for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq > 0) envVars[t.slice(0, eq)] = t.slice(eq + 1);
          }
        }
        execSync('npx next build', {
          cwd: join(dir, 'apps', 'web'),
          stdio: 'ignore',
          timeout: 300000,
          env: envVars,
        });
        nextSpinner.succeed('Web app built');
      } catch (err) {
        nextSpinner.fail('Next.js build failed');
        console.log(chalk.red(`  ${(err as Error).message}`));
        webReady = false;
      }
    }

    // Start in native mode
    if (webReady) {
      try {
        process.chdir(dir);
        const manage = require('./manage');
        await manage.start();
      } catch (err) {
        console.log(chalk.yellow(`  Auto-start failed — run \`slackhive start\` manually (${(err as Error).message})`));
        webReady = false;
      }
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log('');
  if (webReady) {
    console.log('  ' + chalk.bgHex('#D97757').black.bold('  SlackHive is ready!  '));
    console.log('');
    console.log(`  ${chalk.bold('Open:')}     ${chalk.cyan(`http://localhost:${process.env.PORT ?? '3001'}`)}`);
  } else {
    console.log('  ' + chalk.bold('Setup complete!'));
    console.log('');
    console.log(chalk.gray('  Services are still starting. Once ready:'));
    console.log(`  ${chalk.bold('Run:')}      ${chalk.cyan('slackhive start')}`);
    console.log(`  ${chalk.bold('Open:')}     ${chalk.cyan(`http://localhost:${process.env.PORT ?? '3001'}`)}`);
  }
  console.log(`  ${chalk.bold('Dir:')}      ${chalk.gray(dir)}`);
  console.log(`  ${chalk.bold('Mode:')}     ${chalk.gray('Native (SQLite)')}`);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  console.log(`  ${chalk.bold('Database:')} ${chalk.gray(join(home, '.slackhive', 'data.db'))}`);
  console.log(`  ${chalk.bold('Logs:')}     ${chalk.gray(join(home, '.slackhive', 'logs', 'runner.log'))}`);

  console.log('');
  console.log(chalk.gray('  Useful commands:'));
  console.log(chalk.gray('    slackhive start    — Start services'));
  console.log(chalk.gray('    slackhive stop     — Stop services'));
  console.log(chalk.gray('    slackhive status   — Show container status'));
  console.log(chalk.gray('    slackhive logs     — Tail runner logs'));
  console.log(chalk.gray('    slackhive update   — Pull latest & rebuild'));
  console.log('');
}

function randomSecret(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

