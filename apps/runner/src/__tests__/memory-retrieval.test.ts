import { describe, it, expect } from 'vitest';
import type { Memory } from '@slackhive/shared';
import { selectInlineMemories, keywordRank, renderMemoryBlock } from '../memory-retrieval';

function mem(name: string, content: string, opts: Partial<Memory> = {}): Memory {
  return {
    id: opts.id ?? name,
    agentId: 'a1',
    type: opts.type ?? 'reference',
    name,
    content,
    pinned: opts.pinned ?? false,
    scopeUserId: opts.scopeUserId ?? null,
    scopeGroupId: opts.scopeGroupId ?? null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('selectInlineMemories', () => {
  it('includes everything when under budget (no overflow)', () => {
    const mems = [mem('a', 'x'), mem('b', 'y')];
    const { included, overflow } = selectInlineMemories(mems, 32 * 1024);
    expect(included).toHaveLength(2);
    expect(overflow).toHaveLength(0);
  });

  it('overflows non-pinned when over budget, in order', () => {
    const big = 'z'.repeat(200);
    const mems = [mem('a', big), mem('b', big), mem('c', big)];
    const { included, overflow } = selectInlineMemories(mems, 300); // ~fits one block
    expect(included.map(m => m.name)).toEqual(['a']);
    expect(overflow.map(m => m.name)).toEqual(['b', 'c']);
  });

  it('never drops pinned memories, even over budget', () => {
    const big = 'z'.repeat(500);
    const mems = [mem('p1', big, { pinned: true }), mem('p2', big, { pinned: true }), mem('n1', big)];
    const { included, overflow } = selectInlineMemories(mems, 100); // budget too small for any
    expect(included.map(m => m.name).sort()).toEqual(['p1', 'p2']);
    expect(overflow.map(m => m.name)).toEqual(['n1']);
  });
});

describe('keywordRank', () => {
  const mems = [
    mem('refund_policy', 'refunds are processed within 7 days of a cancellation'),
    mem('shipping', 'orders ship from the warehouse in two business days'),
    mem('gmv_rule', 'GMV excludes cancelled bookings and uses gross_total_sgd'),
  ];

  it('ranks by token overlap with the query', () => {
    const out = keywordRank(mems, 'how are refunds handled after cancellation', 5, 32 * 1024);
    expect(out[0].name).toBe('refund_policy');
  });

  it('returns [] for an empty/stopword-only query', () => {
    expect(keywordRank(mems, 'how do you', 5, 32 * 1024)).toEqual([]);
  });

  it('returns [] when nothing matches', () => {
    expect(keywordRank(mems, 'quantum entanglement telescope', 5, 32 * 1024)).toEqual([]);
  });

  it('respects k', () => {
    const out = keywordRank(mems, 'refunds shipping gmv bookings cancellation orders', 1, 32 * 1024);
    expect(out).toHaveLength(1);
  });

  it('respects the byte budget', () => {
    const out = keywordRank(mems, 'refunds shipping gmv', 5, 10); // too small for any block
    expect(out).toHaveLength(0);
  });
});

describe('renderMemoryBlock', () => {
  it('returns null for empty', () => {
    expect(renderMemoryBlock([], 'T', [])).toBeNull();
  });

  it('groups by type with headings and names', () => {
    const out = renderMemoryBlock(
      [mem('r1', 'rc', { type: 'reference' }), mem('f1', 'fc', { type: 'feedback' })],
      '# Title', ['intro'],
    )!;
    expect(out).toContain('# Title');
    expect(out).toContain('intro');
    expect(out).toContain('### f1');
    expect(out).toContain('### r1');
    // feedback group renders before reference group
    expect(out.indexOf('Feedback')).toBeLessThan(out.indexOf('Reference'));
  });
});
