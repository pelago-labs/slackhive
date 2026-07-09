import { describe, it, expect } from 'vitest';
import type { Memory } from '@slackhive/shared';
import { selectForPrompt, renderMemoryBlock } from '../memory-retrieval';

const NO_GROUPS = new Set<string>();

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

describe('selectForPrompt', () => {
  const A = 'U_AAAAAA1';
  const B = 'U_BBBBBB2';

  it('includes all globals when they fit the budget', () => {
    const mems = [mem('a', 'x'), mem('b', 'y')];
    const out = selectForPrompt(mems, { userId: A, groupIds: NO_GROUPS, queryText: '' });
    expect(out.map(m => m.name).sort()).toEqual(['a', 'b']);
  });

  it('always includes pinned + sender-scoped; excludes scoped-to-others', () => {
    const mems = [
      mem('pin', 'p', { pinned: true }),
      mem('mine', 'm', { scopeUserId: A }),
      mem('theirs', 't', { scopeUserId: B }),
      mem('grp', 'g', { scopeGroupId: 'g1' }),
    ];
    const out = selectForPrompt(mems, { userId: A, groupIds: new Set(['g1']), queryText: '' });
    const names = out.map(m => m.name).sort();
    expect(names).toContain('pin');
    expect(names).toContain('mine');
    expect(names).toContain('grp');       // sender is in g1
    expect(names).not.toContain('theirs'); // scoped to B → excluded
  });

  it('over budget, keeps the most keyword-relevant globals', () => {
    // Equal-length bodies so RELEVANCE, not block size, decides what fits.
    const body = (kw: string) => `${kw} ${'z'.repeat(400 - kw.length)}`; // 401 chars each
    const mems = [
      mem('refunds', body('refunds cancellation')),
      mem('shipping', body('shipping warehouse')),
      mem('gmv', body('gmv revenue')),
    ];
    // Effective budget (after the 800B reserve) fits exactly one ~415B block.
    const out = selectForPrompt(mems, { userId: A, groupIds: NO_GROUPS, queryText: 'how are refunds and cancellation handled', budgetBytes: 800 + 430 });
    expect(out.map(m => m.name)).toEqual(['refunds']);
  });

  it('pinned survive even when over budget', () => {
    const big = 'z'.repeat(500);
    const mems = [mem('p1', big, { pinned: true }), mem('p2', big, { pinned: true }), mem('n1', big)];
    const out = selectForPrompt(mems, { userId: A, groupIds: NO_GROUPS, queryText: '', budgetBytes: 100 });
    expect(out.map(m => m.name).sort()).toEqual(['p1', 'p2']); // n1 dropped, pinned kept
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
