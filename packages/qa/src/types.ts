// Skeleton types for @slackhive/qa.
// Per V1-PLAN.md Task 1+ each subsystem extends these as needed.

export type AgentConfig = {
  dir: string;
  claudeMd: ClaudeMdData;
  skills: Skill[];
  wikiEntities: string[];
  mcps: string[]; // tool ids like "mcp__notion__notion-fetch"
};

export type ClaudeMdData = {
  raw: string;
  triggers: string[];
  mcpReferences: string[];
  skillReferences: string[];
  wikiReferences: string[];
};

export type Skill = {
  path: string;
  name: string;
  description: string;
  raw: string;
};

export type Corpus = {
  filePath: string;
  fileMtime: number;
  checks: CheckConfig[];
  cases: Case[];
};

export type CheckConfig = {
  primitive: 'substring' | 'tool_called' | 'llm_judge';
  target?: 'final_reply' | 'tool_calls';
  contains_from?: string;
  not_contains_from?: string;
  must_call_from?: string;
  must_not_call_from?: string;
  rubric?: string;
  case_fields?: string[];
};

export type Case = {
  id: string;
  status: 'approved' | 'proposed';
  question: string;
  approved_by?: string;
  approved_at?: string;
  [key: string]: unknown;
};

export type Trace = {
  finalReply: string;
  toolCalls: ToolCall[];
};

export type ToolCall = {
  toolId: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
};

export type Verdict = 'PASS' | 'FAIL' | 'SUSPECT' | 'INFRA';

export type HealthcheckIssue = {
  code: string;
  severity: 'error' | 'warn';
  file: string;
  line?: number;
  message: string;
};
