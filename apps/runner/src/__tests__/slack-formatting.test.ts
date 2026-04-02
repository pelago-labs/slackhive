/**
 * @fileoverview Unit tests for Slack formatting functions in slack-handler.ts.
 *
 * Covers: formatMessage, stripBotMention, splitTextForBlocks, isSeparatorLine,
 * extractFirstMarkdownTable, parseMarkdownTable, buildSlackTableBlock,
 * buildMessagePayloads, and formatToolStatus.
 *
 * No Slack API or database connection required — all pure functions.
 *
 * @module runner/__tests__/slack-formatting.test
 */

import { describe, it, expect } from 'vitest';
import {
  formatMessage,
  stripBotMention,
  splitTextForBlocks,
  isSeparatorLine,
  extractFirstMarkdownTable,
  parseMarkdownTable,
  buildSlackTableBlock,
  buildMessagePayloads,
  formatToolStatus,
} from '../slack-handler';

// ─── stripBotMention ──────────────────────────────────────────────────────────

describe('stripBotMention', () => {
  it('removes <@BOT_ID> from the start of text', () => {
    expect(stripBotMention('<@U123> hello', 'U123')).toBe('hello');
  });

  it('removes multiple mentions', () => {
    expect(stripBotMention('<@U123> hey <@U123> there', 'U123')).toBe('hey there');
  });

  it('returns text unchanged when botUserId is undefined', () => {
    expect(stripBotMention('<@U123> hello', undefined)).toBe('<@U123> hello');
  });

  it('returns text unchanged when mention is not present', () => {
    expect(stripBotMention('just a message', 'U123')).toBe('just a message');
  });

  it('handles empty string', () => {
    expect(stripBotMention('', 'U123')).toBe('');
  });
});

// ─── formatMessage ────────────────────────────────────────────────────────────

describe('formatMessage', () => {
  it('converts **bold** to *bold*', () => {
    expect(formatMessage('**hello world**', false)).toBe('*hello world*');
  });

  it('converts __italic__ to _italic_', () => {
    expect(formatMessage('__hello world__', false)).toBe('_hello world_');
  });

  it('converts heading to *bold*', () => {
    expect(formatMessage('## Section Title', false)).toBe('*Section Title*');
  });

  it('converts h1 heading', () => {
    expect(formatMessage('# Top Level', false)).toBe('*Top Level*');
  });

  it('converts h6 heading', () => {
    expect(formatMessage('###### Deep', false)).toBe('*Deep*');
  });

  it('removes HR lines (---)', () => {
    const result = formatMessage('above\n---\nbelow', false);
    expect(result).not.toContain('---');
    expect(result).toContain('above');
    expect(result).toContain('below');
  });

  it('removes HR lines (***)', () => {
    const result = formatMessage('above\n***\nbelow', false);
    expect(result).not.toContain('***');
  });

  it('preserves code blocks as-is', () => {
    const input = 'Look at this:\n```python\nprint("hello")\n```\nDone.';
    const result = formatMessage(input, false);
    expect(result).toContain('```\nprint("hello")\n```');
  });

  it('strips language hint from code block', () => {
    const result = formatMessage('```javascript\nconst x = 1;\n```', false);
    expect(result).toBe('```\nconst x = 1;\n```');
  });

  it('does not convert **bold** inside code blocks', () => {
    const result = formatMessage('```\n**not bold**\n```', false);
    expect(result).toContain('**not bold**');
  });

  it('handles text with no formatting', () => {
    expect(formatMessage('plain text', false)).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(formatMessage('', false)).toBe('');
  });

  it('handles multiple bold spans in one line', () => {
    const result = formatMessage('**a** and **b**', false);
    expect(result).toBe('*a* and *b*');
  });
});

// ─── splitTextForBlocks ───────────────────────────────────────────────────────

describe('splitTextForBlocks', () => {
  it('returns single chunk for text under 3000 chars', () => {
    const text = 'hello world';
    expect(splitTextForBlocks(text)).toEqual([text]);
  });

  it('splits text over 3000 chars into multiple chunks', () => {
    const text = 'a'.repeat(3500);
    const chunks = splitTextForBlocks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
  });

  it('splits at newline boundary when possible', () => {
    const line = 'x'.repeat(100);
    const text = Array(35).fill(line).join('\n'); // ~3535 chars with newlines
    const chunks = splitTextForBlocks(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3000);
    }
  });

  it('handles exactly 3000 chars as single chunk', () => {
    const text = 'a'.repeat(3000);
    expect(splitTextForBlocks(text)).toEqual([text]);
  });
});

// ─── isSeparatorLine ─────────────────────────────────────────────────────────

describe('isSeparatorLine', () => {
  it('returns true for standard separator | --- | --- |', () => {
    expect(isSeparatorLine('| --- | --- |')).toBe(true);
  });

  it('returns true for separator with alignment colons', () => {
    expect(isSeparatorLine('| :--- | ---: | :---: |')).toBe(true);
  });

  it('returns true for separator without pipes', () => {
    expect(isSeparatorLine('--- | --- | ---')).toBe(true);
  });

  it('returns false for a normal text row', () => {
    expect(isSeparatorLine('| Name | Value |')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSeparatorLine('')).toBe(false);
  });

  it('returns false for a line with only spaces', () => {
    expect(isSeparatorLine('   ')).toBe(false);
  });
});

// ─── extractFirstMarkdownTable ────────────────────────────────────────────────

describe('extractFirstMarkdownTable', () => {
  const simpleTable = '| A | B |\n| --- | --- |\n| 1 | 2 |';

  it('returns null for text with no table', () => {
    expect(extractFirstMarkdownTable('just plain text')).toBeNull();
  });

  it('extracts a bare pipe table', () => {
    const result = extractFirstMarkdownTable(simpleTable);
    expect(result).not.toBeNull();
    expect(result!.tableLines.length).toBeGreaterThanOrEqual(3);
  });

  it('splits before/after text correctly', () => {
    const text = `intro text\n${simpleTable}\noutro text`;
    const result = extractFirstMarkdownTable(text);
    expect(result).not.toBeNull();
    expect(result!.before).toContain('intro text');
    expect(result!.after).toContain('outro text');
  });

  it('returns null for table without separator line', () => {
    const noSep = '| A | B |\n| 1 | 2 |\n| 3 | 4 |';
    expect(extractFirstMarkdownTable(noSep)).toBeNull();
  });

  it('extracts table from inside a code block', () => {
    const text = '```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```';
    const result = extractFirstMarkdownTable(text);
    expect(result).not.toBeNull();
  });
});

// ─── parseMarkdownTable ───────────────────────────────────────────────────────

describe('parseMarkdownTable', () => {
  const lines = ['| Name | Value | Score |', '| --- | ---: | :---: |', '| Alice | 100 | A |', '| Bob | 200 | B |'];

  it('extracts headers correctly', () => {
    const { headers } = parseMarkdownTable(lines);
    expect(headers).toEqual(['Name', 'Value', 'Score']);
  });

  it('extracts rows correctly', () => {
    const { rows } = parseMarkdownTable(lines);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['Alice', '100', 'A']);
    expect(rows[1]).toEqual(['Bob', '200', 'B']);
  });

  it('detects right alignment from ---:', () => {
    const { alignments } = parseMarkdownTable(lines);
    expect(alignments[1]).toBe('right');
  });

  it('detects center alignment from :---:', () => {
    const { alignments } = parseMarkdownTable(lines);
    expect(alignments[2]).toBe('center');
  });

  it('defaults to left alignment', () => {
    const { alignments } = parseMarkdownTable(lines);
    expect(alignments[0]).toBe('left');
  });

  it('handles single-column table', () => {
    const single = ['| Name |', '| --- |', '| Alice |'];
    const { headers, rows } = parseMarkdownTable(single);
    expect(headers).toEqual(['Name']);
    expect(rows[0]).toEqual(['Alice']);
  });
});

// ─── buildSlackTableBlock ─────────────────────────────────────────────────────

describe('buildSlackTableBlock', () => {
  const parsed = {
    headers: ['Name', 'Score'],
    rows: [['Alice', '100'], ['Bob', '200']],
    alignments: ['left', 'right'] as ('left' | 'right')[],
  };

  it('returns a block with type "table"', () => {
    const block = buildSlackTableBlock(parsed);
    expect(block.type).toBe('table');
  });

  it('includes header row as first row', () => {
    const block = buildSlackTableBlock(parsed);
    expect(block.rows[0][0].text).toBe('Name');
    expect(block.rows[0][1].text).toBe('Score');
  });

  it('includes data rows after header', () => {
    const block = buildSlackTableBlock(parsed);
    expect(block.rows[1][0].text).toBe('Alice');
    expect(block.rows[2][0].text).toBe('Bob');
  });

  it('sets column alignment settings', () => {
    const block = buildSlackTableBlock(parsed);
    expect(block.column_settings[0].align).toBe('left');
    expect(block.column_settings[1].align).toBe('right');
  });

  it('caps rows at 99 data rows', () => {
    const manyRows = Array.from({ length: 150 }, (_, i) => [`row${i}`, `${i}`]);
    const block = buildSlackTableBlock({ ...parsed, rows: manyRows });
    expect(block.rows.length).toBeLessThanOrEqual(100); // header + 99
  });

  it('fills missing cells with empty string', () => {
    const sparse = { headers: ['A', 'B', 'C'], rows: [['only-a']], alignments: ['left', 'left', 'left'] as ('left')[]} ;
    const block = buildSlackTableBlock(sparse);
    expect(block.rows[1][1].text).toBe('');
    expect(block.rows[1][2].text).toBe('');
  });
});

// ─── buildMessagePayloads ─────────────────────────────────────────────────────

describe('buildMessagePayloads', () => {
  it('returns text-only payload for plain text', () => {
    const payloads = buildMessagePayloads('Hello world', false);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].text).toBeTruthy();
    expect(payloads[0].blocks).toBeUndefined();
  });

  it('returns blocks payload when text contains a table', () => {
    const text = 'Results:\n| A | B |\n| --- | --- |\n| 1 | 2 |\nDone.';
    const payloads = buildMessagePayloads(text, true);
    const tablePayload = payloads.find(p => p.blocks?.some((b: any) => b.type === 'table'));
    expect(tablePayload).toBeDefined();
  });

  it('includes before-text section block when text precedes table', () => {
    const text = 'Here are results:\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const payloads = buildMessagePayloads(text, true);
    const tablePayload = payloads.find(p => p.blocks?.some((b: any) => b.type === 'table'));
    const sections = tablePayload!.blocks!.filter((b: any) => b.type === 'section');
    expect(sections.some((s: any) => s.text.text.includes('Here are results'))).toBe(true);
  });

  it('splits multiple tables into separate payloads', () => {
    const text = 'Table 1:\n| A | B |\n| --- | --- |\n| 1 | 2 |\nTable 2:\n| C | D |\n| --- | --- |\n| 3 | 4 |';
    const payloads = buildMessagePayloads(text, true);
    const tablePayloads = payloads.filter(p => p.blocks?.some((b: any) => b.type === 'table'));
    expect(tablePayloads.length).toBe(2);
  });

  it('applies formatMessage to text field', () => {
    const payloads = buildMessagePayloads('**bold** text', false);
    expect(payloads[0].text).toContain('*bold*');
  });
});

// ─── formatToolStatus ─────────────────────────────────────────────────────────

describe('formatToolStatus', () => {
  it('returns null for empty content array', () => {
    expect(formatToolStatus([])).toBeNull();
  });

  it('returns null when no tool_use block present', () => {
    expect(formatToolStatus([{ type: 'text', text: 'hello' }])).toBeNull();
  });

  it('returns *Working...* for unknown tool', () => {
    const content = [{ type: 'tool_use', name: 'unknown_tool', input: {} }];
    expect(formatToolStatus(content)).toBe('*Working...*');
  });

  it('formats known tool without special input as label...', () => {
    const content = [{ type: 'tool_use', name: 'mcp__redshift-mcp__describe_table', input: {} }];
    expect(formatToolStatus(content)).toBe('*Inspecting table structure...*');
  });

  it('formats redshift query tool with SQL block', () => {
    const content = [{ type: 'tool_use', name: 'mcp__redshift-mcp__query', input: { sql: 'SELECT * FROM orders' } }];
    const result = formatToolStatus(content);
    expect(result).toContain('Querying Redshift');
    expect(result).toContain('SELECT * FROM orders');
    expect(result).toContain('```sql');
  });

  it('truncates SQL at 500 chars', () => {
    const longSql = 'SELECT ' + 'x'.repeat(600);
    const content = [{ type: 'tool_use', name: 'mcp__redshift-mcp__query', input: { sql: longSql } }];
    const result = formatToolStatus(content)!;
    expect(result.length).toBeLessThan(longSql.length);
  });

  it('formats tool with query input', () => {
    const content = [{ type: 'tool_use', name: 'mcp__mcp-server-openmetadata-PRD__search_entities', input: { query: 'orders table' } }];
    const result = formatToolStatus(content);
    expect(result).toContain('Searching metadata catalog');
    expect(result).toContain('orders table');
  });

  it('formats tool with fqn input', () => {
    const content = [{ type: 'tool_use', name: 'mcp__mcp-server-openmetadata-PRD__get_table_by_name', input: { fqn: 'db.schema.orders' } }];
    const result = formatToolStatus(content);
    expect(result).toContain('db.schema.orders');
  });

  it('uses first tool_use block when multiple exist', () => {
    const content = [
      { type: 'tool_use', name: 'mcp__redshift-mcp__query', input: { sql: 'SELECT 1' } },
      { type: 'tool_use', name: 'unknown_tool', input: {} },
    ];
    const result = formatToolStatus(content)!;
    expect(result).toContain('Querying Redshift');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('formatMessage — edge cases', () => {
  it('handles multiple code blocks in one message', () => {
    const input = '```js\nfoo()\n```\ntext\n```py\nbar()\n```';
    const result = formatMessage(input, false);
    expect(result).toContain('```\nfoo()\n```');
    expect(result).toContain('```\nbar()\n```');
  });

  it('does not strip dashes inside words (only HR lines)', () => {
    const result = formatMessage('some-word and another-word', false);
    expect(result).toContain('some-word');
    expect(result).toContain('another-word');
  });

  it('handles nested asterisks correctly', () => {
    const result = formatMessage('**bold** and *already slack*', false);
    expect(result).toBe('*bold* and *already slack*');
  });
});

describe('extractFirstMarkdownTable — edge cases', () => {
  it('returns null for text with only one table row', () => {
    expect(extractFirstMarkdownTable('| A | B |')).toBeNull();
  });

  it('picks the earliest table when multiple tables exist', () => {
    const text = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\nsome text\n\n| C | D |\n| --- | --- |\n| 3 | 4 |';
    const result = extractFirstMarkdownTable(text);
    expect(result).not.toBeNull();
    expect(result!.tableLines[0]).toContain('A');
  });
});

describe('parseMarkdownTable — edge cases', () => {
  it('handles rows with fewer cells than headers (pads with empty)', () => {
    const lines = ['| A | B | C |', '| --- | --- | --- |', '| 1 |'];
    const { rows } = parseMarkdownTable(lines);
    expect(rows[0]).toHaveLength(1); // splitRow only produces what's there
  });

  it('handles table with no data rows (headers + separator only)', () => {
    const lines = ['| A | B |', '| --- | --- |'];
    const { rows } = parseMarkdownTable(lines);
    expect(rows).toHaveLength(0);
  });
});

describe('formatToolStatus — edge cases', () => {
  it('returns null when content has only text blocks', () => {
    const content = [{ type: 'text', text: 'thinking...' }];
    expect(formatToolStatus(content)).toBeNull();
  });

  it('formats tool with name input (fqn fallback to name)', () => {
    const content = [{ type: 'tool_use', name: 'mcp__mcp-server-openmetadata-PRD__get_table', input: { name: 'orders' } }];
    const result = formatToolStatus(content);
    expect(result).toContain('orders');
  });

  it('handles tool_use with no special input fields gracefully', () => {
    const content = [{ type: 'tool_use', name: 'mcp__mcp-server-openmetadata-PRD__list_tables', input: {} }];
    const result = formatToolStatus(content);
    expect(result).toContain('Listing tables');
  });
});

describe('buildMessagePayloads — edge cases', () => {
  it('returns plain text payload when table has no headers', () => {
    // A "table" with only separator row — invalid
    const text = 'some text\n| --- | --- |\nmore text';
    const payloads = buildMessagePayloads(text, false);
    // Should not crash, returns text payload
    expect(payloads[0].text).toBeTruthy();
  });

  it('handles empty string input', () => {
    const payloads = buildMessagePayloads('', false);
    expect(payloads[0].text).toBeDefined();
  });

  it('handles very long text without table', () => {
    const longText = 'word '.repeat(2000);
    const payloads = buildMessagePayloads(longText, false);
    expect(payloads[0].text).toBeTruthy();
    expect(payloads[0].blocks).toBeUndefined();
  });
});
