/**
 * Manual test: can Codex read a PDF staged in its working directory?
 * Runs exactly like the runner — loads ENV_SECRET_KEY from .env,
 * decrypts env vars from DB, passes them to Codex.
 *
 * Run from apps/runner: npx tsx src/__tests__/codex-pdf-staging.manual.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Codex as CodexType } from '@openai/codex-sdk';

// Load .env the same way slackhive CLI does
const envFile = path.resolve(__dirname, '../../../../.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.resolve(os.homedir(), '.slackhive/data.db');

async function main() {
  const { initDb } = await import('@slackhive/shared');
  const { getAllEnvVarValues } = await import('../db');

  await initDb();
  const envVarValues = await getAllEnvVarValues();

  // Codex uses subscription auth via ~/.codex/auth.json (no API key needed)
  const authJson = path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(authJson)) {
    console.error('No ~/.codex/auth.json found — run `codex login` first');
    process.exit(1);
  }
  console.log('Using subscription auth from', authJson);

  // Stage the real fraud PDF
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pdf-test-'));
  fs.mkdirSync(path.join(workDir, 'attachments'));
  const PDF_SRC = '/tmp/codex-pdf-test/EOD_Fraud_Check_2026-05-02T09_36_18.pdf';
  fs.copyFileSync(PDF_SRC, path.join(workDir, 'attachments', 'EOD_Fraud_Check.pdf'));
  console.log('workDir:', workDir);
  console.log('PDF staged at:', path.join(workDir, 'attachments', 'EOD_Fraud_Check.pdf'));

  const { Codex } = await import('@openai/codex-sdk') as { Codex: typeof CodexType };
  const codex = new Codex({
    config: { cli_auth_credentials_store: 'file' },
  });

  const thread = codex.startThread({
    workingDirectory: workDir,
    sandboxMode: 'workspace-write',
    skipGitRepoCheck: true,
  });

  console.log('\nRunning Codex turn...\n');
  const result = await thread.run([
    {
      type: 'text',
      text: 'An EOD fraud check PDF is at ./attachments/EOD_Fraud_Check.pdf in your working directory. Use pdftotext to read it (run: pdftotext ./attachments/EOD_Fraud_Check.pdf -) then summarise: (1) total failed/rejected booking count, (2) top failure codes by frequency, (3) any patterns that stand out.',
    },
  ]);

  console.log('\n=== FINAL RESPONSE ===');
  console.log(result.finalResponse);
  console.log('\n=== COMMANDS RUN ===');
  for (const item of result.items) {
    if (item.type === 'command_execution') {
      console.log(`$ ${item.command}`);
      console.log((item.aggregated_output ?? '').slice(0, 500));
      console.log('---');
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
