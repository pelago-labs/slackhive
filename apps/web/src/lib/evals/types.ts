/**
 * @fileoverview Type definitions for the agent evals subsystem.
 *
 * The Tier 1 healthcheck takes slackhive's native Agent / Skill /
 * McpServer / WikiFolder types directly — there's no separate config
 * shape and no on-disk loader. The types here are internal eval
 * shapes only: issues, summaries, and the parsed-markdown output
 * we extract from an agent's raw CLAUDE.md string.
 *
 * @module web/lib/evals
 */

/**
 * A single issue reported by a Tier 1 check.
 *
 * Each check (QA001–QA009) returns zero or more issues; the
 * aggregator concatenates them into a flat list keyed by `code`.
 */
export type HealthcheckIssue = {
  /** Check identifier — `QA001` through `QA009`. */
  code: string;
  severity: 'error' | 'warn';
  /** File the issue points at (e.g., `CLAUDE.md`, `skills/00-core/workflow.md`). */
  file: string;
  /** Optional 1-indexed line number within `file`. */
  line?: number;
  message: string;
};

/**
 * Aggregated counts across a healthcheck run.
 */
export type Summary = {
  total: number;
  errors: number;
  warnings: number;
};

/**
 * Full result of a `runHealthcheck()` call — what the API route returns.
 */
export type HealthcheckResult = {
  summary: Summary;
  issues: HealthcheckIssue[];
};

/**
 * Output of parsing an agent's raw `claudeMd` string.
 *
 * CLAUDE.md is a single big markdown blob mixing persona text,
 * Step 0 trigger patterns, and inline references to skills, wiki
 * entities, and MCP tools. Several checks need these references
 * extracted to compare against the agent's declared skills / wiki
 * folders / MCP servers.
 */
export type ParsedClaudeMd = {
  /** The original raw markdown, untouched. */
  raw: string;
  /** Step 0 trigger patterns (e.g., backticked terms). */
  triggers: string[];
  /** Distinct `mcp__<server>__<tool>` references found in the markdown. */
  mcpReferences: string[];
  /** Skill markdown link paths (e.g., `skills/00-core/workflow.md`). */
  skillReferences: string[];
  /** Wiki entity references (e.g., `[[dim-orders]]`). */
  wikiReferences: string[];
};

/**
 * Shared input to every Tier 1 check function.
 *
 * The orchestrator (`runHealthcheck`) builds this once from the
 * agent and its related rows, then passes it to each check.
 * Checks use whichever fields they need.
 */
export type CheckContext = {
  parsedClaudeMd: ParsedClaudeMd;
  skills: import('@slackhive/shared').Skill[];
  mcps: import('@slackhive/shared').McpServer[];
  wikiSources: import('@slackhive/shared').WikiSource[];
};
