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
  const corpus = loadCorpus(dir, opts);

  const config: AgentConfig = {
    dir,
    claudeMd,
    skills,
    wikiEntities,
    mcps,
  };

  return { config, corpus };
}

export { loadCorpus, type LoadCorpusOptions } from './corpus';
