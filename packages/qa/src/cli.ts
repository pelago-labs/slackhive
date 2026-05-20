#!/usr/bin/env node

import { loadAgent } from './loader';
import { runHealthcheck } from './healthcheck';
import { reportEslintStyle, reportJson, summarize } from './healthcheck/reporter';

function usage(stream: 'stdout' | 'stderr' = 'stderr'): void {
  const out =
    'Usage: slackhive-qa healthcheck <agent-dir> [--json] [--include-proposed]\n' +
    '\n' +
    'Subcommands:\n' +
    '  healthcheck <dir>   Run static healthcheck (Tier 1) against an agent directory\n' +
    '\n' +
    'Options:\n' +
    '  --json              Output machine-parseable JSON instead of eslint-style\n' +
    '  --include-proposed  Include proposed (unapproved) test cases when loading the corpus\n' +
    '  -h, --help          Show this message';
  (stream === 'stdout' ? console.log : console.error)(out);
}

function main(argv: string[]): number {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    usage(argv.length === 0 ? 'stderr' : 'stdout');
    return argv.length === 0 ? 2 : 0;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand !== 'healthcheck') {
    console.error(`error: unknown subcommand "${subcommand}"`);
    usage();
    return 2;
  }

  const json = rest.includes('--json');
  const includeProposed = rest.includes('--include-proposed');
  const positional = rest.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) {
    console.error('error: healthcheck requires exactly one <agent-dir> argument');
    usage();
    return 2;
  }
  const dir = positional[0];

  let result;
  try {
    result = loadAgent(dir, { includeProposed });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const issues = runHealthcheck(result.config, result.corpus, result.corpusError);

  if (json) {
    console.log(reportJson(issues));
  } else {
    console.log(reportEslintStyle(issues));
  }

  const summary = summarize(issues);
  return summary.errors > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
