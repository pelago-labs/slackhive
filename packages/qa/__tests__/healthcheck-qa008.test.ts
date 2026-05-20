import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgent } from '../src';
import { runQA008 } from '../src/healthcheck/qa008-test-coverage';

const GOOD = resolve(__dirname, 'fixtures/good-agent');

describe('QA008 — test coverage', () => {
  it('returns zero issues for a clean agent (case covers trigger + skill)', () => {
    const { config, corpus } = loadAgent(GOOD);
    expect(runQA008(config, corpus)).toEqual([]);
  });

  it('flags uncovered trigger', () => {
    const synthetic = {
      config: {
        dir: '/fake',
        claudeMd: {
          raw: '',
          triggers: ['undocumented trigger phrase'],
          mcpReferences: [],
          skillReferences: [],
          wikiReferences: [],
        },
        skills: [],
        wikiEntities: [],
        mcps: [],
      },
      corpus: {
        filePath: '/fake/eval/tests.yaml',
        fileMtime: Date.now(),
        checks: [],
        cases: [
          { id: 'X1', status: 'approved' as const, question: 'totally unrelated case' },
        ],
      },
    };
    const issues = runQA008(synthetic.config, synthetic.corpus);
    expect(issues.length).toBe(1);
    expect(issues[0].code).toBe('QA008');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].message).toContain('undocumented trigger phrase');
  });

  it('flags uncovered skill', () => {
    const synthetic = {
      config: {
        dir: '/fake',
        claudeMd: {
          raw: '',
          triggers: [],
          mcpReferences: [],
          skillReferences: [],
          wikiReferences: [],
        },
        skills: [
          {
            path: 'unprobed.md',
            name: 'unprobed-skill',
            description: 'A skill with unique tokens like xyzzyabc',
            raw: '',
          },
        ],
        wikiEntities: [],
        mcps: [],
      },
      corpus: {
        filePath: '/fake/eval/tests.yaml',
        fileMtime: Date.now(),
        checks: [],
        cases: [
          { id: 'X1', status: 'approved' as const, question: 'totally unrelated case' },
        ],
      },
    };
    const issues = runQA008(synthetic.config, synthetic.corpus);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('unprobed-skill');
  });

  it('returns no issues when corpus is null', () => {
    const cfg = {
      dir: '/fake',
      claudeMd: {
        raw: '',
        triggers: ['some trigger'],
        mcpReferences: [],
        skillReferences: [],
        wikiReferences: [],
      },
      skills: [],
      wikiEntities: [],
      mcps: [],
    };
    expect(runQA008(cfg, null)).toEqual([]);
  });
});
