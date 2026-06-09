import { describe, it, expect } from 'vitest';
import { parseCoachProposals } from '../coach-handler';

const PROPOSAL = '[{ "kind": "instructions", "content": "new body", "rationale": "why" }]';

describe('parseCoachProposals', () => {
  it('parses the documented ```coach-proposals fence', () => {
    const { message, raw } = parseCoachProposals(`Here you go.\n\n\`\`\`coach-proposals\n${PROPOSAL}\n\`\`\``);
    expect(raw).toHaveLength(1);
    expect(raw[0].kind).toBe('instructions');
    expect(message).toBe('Here you go.');
  });

  it('parses a ```json fence (the label the model actually tends to emit)', () => {
    const { raw, message } = parseCoachProposals(`Done.\n\n\`\`\`json\n${PROPOSAL}\n\`\`\``);
    expect(raw).toHaveLength(1);
    expect(message).toBe('Done.');
  });

  it('parses a bare ``` fence containing a proposal array', () => {
    const { raw } = parseCoachProposals(`ok\n\n\`\`\`\n${PROPOSAL}\n\`\`\``);
    expect(raw).toHaveLength(1);
  });

  it('picks the proposal array even when other fenced blocks are present', () => {
    const { raw } = parseCoachProposals(
      `\`\`\`sql\nSELECT 1\n\`\`\`\n\nand the changes:\n\n\`\`\`json\n${PROPOSAL}\n\`\`\``,
    );
    expect(raw).toHaveLength(1);
    expect(raw[0].kind).toBe('instructions');
  });

  it('returns no proposals for prose-only replies', () => {
    const { raw, message } = parseCoachProposals('I would suggest excluding free eSIM, but no changes yet.');
    expect(raw).toHaveLength(0);
    expect(message).toContain('free eSIM');
  });

  it('ignores non-proposal JSON arrays (no kind field)', () => {
    const { raw } = parseCoachProposals('data:\n\n```json\n[{"a":1},{"b":2}]\n```');
    expect(raw).toHaveLength(0);
  });

  it('parses when a proposal content field itself contains ``` code fences (the real bug)', () => {
    // The instructions body has fenced SQL — a regex-based fence parser truncates
    // the JSON at the inner ```; the balanced/string-aware scanner must not.
    const withFences = JSON.stringify([{
      kind: 'instructions',
      content: 'Rule: exclude free eSIM.\n\n```sql\nSELECT * FROM b WHERE x [1] = 1;\n```\n\nDone.',
      rationale: 'operator asked',
    }]);
    const { raw, message } = parseCoachProposals(`Here is the change.\n\n\`\`\`json\n${withFences}\n\`\`\``);
    expect(raw).toHaveLength(1);
    expect(raw[0].kind).toBe('instructions');
    expect(String(raw[0].content)).toContain('```sql');
    expect(message).toBe('Here is the change.');
  });
});
