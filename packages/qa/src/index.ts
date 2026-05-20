// Public API barrel. Populated as tasks land per V1-PLAN.md.
export * from './types';
export {
  loadAgent,
  loadCorpus,
  type LoadAgentOptions,
  type LoadAgentResult,
  type LoadCorpusOptions,
} from './loader';
export { runQA001 } from './healthcheck/qa001-mcp-coverage';
export { runQA002 } from './healthcheck/qa002-cross-refs';
export { runQA005 } from './healthcheck/qa005-persona-hygiene';
export { runQA006 } from './healthcheck/qa006-tool-prefix';
