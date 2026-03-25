/**
 * @fileoverview Built-in skill templates for bootstrapping new agents.
 *
 * When creating a new agent, users choose a template that provides starter
 * skill files. These are seeded into the `skills` table and compiled into
 * the agent's initial CLAUDE.md.
 *
 * Templates:
 * - `blank`        — Minimal identity skill only
 * - `data-analyst` — SQL/data analysis (based on NLQ bot patterns)
 * - `writer`       — Content generation and summarization
 * - `developer`    — Code review and development assistance
 *
 * @module web/lib/skill-templates
 */

import type { Agent, SkillTemplate } from '@slack-agent-team/shared';

/** A skill file definition for seeding. */
interface SkillSeed {
  category: string;
  filename: string;
  content: string;
  sortOrder: number;
}

/**
 * Map of template name → function that generates initial skill seeds.
 * Each function receives the newly created agent for name/persona interpolation.
 */
export const SKILL_TEMPLATES: Record<SkillTemplate, (agent: Agent) => SkillSeed[]> = {

  blank: (agent) => [
    {
      category: '00-core',
      filename: 'identity.md',
      sortOrder: 0,
      content: `# ${agent.name}

${agent.persona ?? `You are ${agent.name}, a helpful AI assistant.`}

${agent.description ? `## What you do\n\n${agent.description}` : ''}
`,
    },
  ],

  'data-analyst': (agent) => [
    {
      category: '00-core',
      filename: 'identity.md',
      sortOrder: 0,
      content: `# ${agent.name}

${agent.persona ?? `You are ${agent.name}, a data analyst AI agent.`}

Users ask business questions in plain English. You investigate the data,
run queries when needed, and deliver clear, concise insights.
`,
    },
    {
      category: '00-core',
      filename: 'workflow.md',
      sortOrder: 1,
      content: `# Workflow

1. **Understand** the question — identify metrics, dimensions, and time range
2. **Discover** schema if needed — describe tables, find columns
3. **Plan** the query — identify joins, aggregations, filters
4. **Execute** — run the query and validate results
5. **Respond** — present findings clearly with numbers from actual query results

## Rules
- Always run queries before stating numbers — never guess
- Validate JOIN fan-out before returning aggregations
- If a query returns no results, investigate why before concluding
`,
    },
    {
      category: '00-core',
      filename: 'response-format.md',
      sortOrder: 2,
      content: `# Response Format

- Lead with the answer, then supporting data
- Use Slack formatting: *bold* for metrics, \`code\` for table/column names
- Format numbers: 1,234 (comma-separated), percentages with 1 decimal
- Use tables for comparisons (pipe-delimited Markdown)
- Keep responses concise — no filler phrases
`,
    },
  ],

  writer: (agent) => [
    {
      category: '00-core',
      filename: 'identity.md',
      sortOrder: 0,
      content: `# ${agent.name}

${agent.persona ?? `You are ${agent.name}, a content writing and summarization AI agent.`}

You help teams generate clear, well-structured written content: summaries,
announcements, reports, Slack messages, and documentation.
`,
    },
    {
      category: '00-core',
      filename: 'style-guide.md',
      sortOrder: 1,
      content: `# Writing Style Guide

- Be clear and concise — cut unnecessary words
- Active voice over passive voice
- Use bullet points for lists of 3+ items
- Match the tone to the audience (technical vs. executive)
- For Slack: use *bold* for key points, avoid walls of text
`,
    },
  ],

  developer: (agent) => [
    {
      category: '00-core',
      filename: 'identity.md',
      sortOrder: 0,
      content: `# ${agent.name}

${agent.persona ?? `You are ${agent.name}, a software development AI agent.`}

You help with code review, debugging, architecture decisions, and
implementation guidance. You prioritize correctness, security, and readability.
`,
    },
    {
      category: '00-core',
      filename: 'code-standards.md',
      sortOrder: 1,
      content: `# Code Standards

- Prefer simple, explicit code over clever abstractions
- Always consider security implications (injection, XSS, auth)
- Write tests for non-trivial logic
- Follow the existing patterns in the codebase
- Explain why, not just what
`,
    },
  ],
};
