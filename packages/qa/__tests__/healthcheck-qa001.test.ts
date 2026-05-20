import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA001 } from '../src/healthcheck/qa001-mcp-coverage';

const GOOD = resolve(__dirname, 'fixtures/good-agent');
const BAD = resolve(__dirname, 'fixtures/bad-agent');

describe('QA001 — MCP coverage', () => {
  it('returns zero issues for a clean agent', () => {
    const { config } = loadAgent(GOOD);
    expect(runQA001(config)).toEqual([]);
  });

  it('flags MCP references whose server is not declared in mcps.yaml', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA001(config);

    expect(issues.length).toBeGreaterThanOrEqual(2); // one in CLAUDE.md, one in skill
    for (const issue of issues) {
      expect(issue.code).toBe('QA001');
      expect(issue.severity).toBe('error');
      expect(issue.message).toContain('not declared');
      expect(issue.line).toBeGreaterThan(0);
    }

    const files = new Set(issues.map((i) => i.file));
    expect([...files].some((f) => f.endsWith('CLAUDE.md'))).toBe(true);
    expect([...files].some((f) => f.endsWith('bad-skill.md'))).toBe(true);
  });

  it('reports the undeclared server name in the message', () => {
    const { config } = loadAgent(BAD);
    const issues = runQA001(config);
    const servers = issues.map((i) => i.message);
    expect(servers.some((m) => m.includes('undeclared-tool'))).toBe(true);
    expect(servers.some((m) => m.includes('another-undeclared'))).toBe(true);
  });
});
