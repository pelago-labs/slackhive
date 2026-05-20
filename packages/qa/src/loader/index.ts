import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentConfig, Corpus } from '../types';
import { loadClaudeMd } from './claude-md';
import { loadSkills } from './skills';
import { loadWikiEntities } from './wiki';
import { loadMcpServerNames } from './mcps-yaml';
import { loadCorpus, type LoadCorpusOptions } from './corpus';

export type LoadAgentOptions = LoadCorpusOptions;

export type LoadAgentResult = {
  config: AgentConfig;
  corpus: Corpus | null;
  /**
   * Set when an `eval/tests.yaml` file exists but failed to parse (malformed
   * YAML, wrong top-level shape, etc.). The aggregator surfaces this as a
   * QA009 issue rather than aborting the whole healthcheck run.
   */
  corpusError?: string;
};

export function loadAgent(agentDir: string, opts: LoadAgentOptions = {}): LoadAgentResult {
  const dir = resolve(agentDir);
  if (!existsSync(dir)) {
    throw new Error(`Agent directory does not exist: ${dir}`);
  }

  const claudeMd = loadClaudeMd(dir);
  const skills = loadSkills(dir);
  const wikiEntities = loadWikiEntities(dir);
  const mcps = loadMcpServerNames(dir);

  let corpus: Corpus | null = null;
  let corpusError: string | undefined;
  try {
    corpus = loadCorpus(dir, opts);
  } catch (err) {
    corpusError = err instanceof Error ? err.message : String(err);
  }

  const config: AgentConfig = {
    dir,
    claudeMd,
    skills,
    wikiEntities,
    mcps,
  };

  return { config, corpus, corpusError };
}

export { loadCorpus, type LoadCorpusOptions } from './corpus';
