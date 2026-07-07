/**
 * @fileoverview Tiered-memory selection + retrieval helpers.
 *
 * Pure functions shared by the compile-time inliner (CLAUDE.md) and the per-turn
 * prompt builder so both agree on which memories are "already inlined":
 *   - selectInlineMemories: deterministic, pinned-first fill to a byte budget.
 *   - keywordRank: token-overlap ranking of the overflow against the user message
 *     (the "needed sometime" tier — no embeddings).
 *   - renderMemoryBlock: the shared group-by-type markdown formatter.
 *
 * @module runner/memory-retrieval
 */
import type { Memory } from '@slackhive/shared';

/** Byte budget for the always-inlined (CLAUDE.md) memory set. Shared by the
 *  compile-time inliner AND the per-turn resolver so both compute the same
 *  included/overflow split (prevents selector drift). */
export const MAX_INLINED_MEMORY_BYTES = 32 * 1024;
/** Per-turn budgets for the scoped ("who is asking") and retrieved ("sometimes")
 *  tiers, and the max memories the retrieved tier injects per turn. */
export const MAX_SCOPED_MEMORY_BYTES = 8 * 1024;
export const MAX_RETRIEVED_MEMORY_BYTES = 8 * 1024;
export const MEMORY_RETRIEVE_K = 6;

const TYPE_ORDER: Memory['type'][] = ['feedback', 'user', 'project', 'reference'];
const TYPE_HEADINGS: Record<Memory['type'], string> = {
  feedback: 'Feedback (behavioral rules — apply unconditionally)',
  user: 'User (facts about people)',
  project: 'Project (current initiatives)',
  reference: 'Reference (domain knowledge)',
};

/** Byte cost of one memory as rendered (`### name` + body) — the unit both the
 *  selector and the keyword ranker budget against. */
function memoryBlockBytes(m: Memory): number {
  return Buffer.byteLength(`\n### ${m.name}\n${m.content.trim()}\n`, 'utf-8');
}

/** Reserve for the rendered section's title + intro + up to four `## ` group
 *  headings, so the whole block (not just raw memory content) stays under the
 *  caller's budget. Applied inside selectInlineMemories so compile-time and
 *  per-turn use the identical effective budget (no selector drift). */
const SECTION_OVERHEAD_BYTES = 800;

/**
 * Split memories into what fits the inline budget vs the overflow.
 * Pinned memories are ALWAYS included (the "remember always" tier, never
 * dropped); the rest fill the remaining budget in their given order. The
 * overflow is what the per-turn retrieved tier keyword-ranks. Deterministic:
 * the same input always yields the same split, so compile-time and per-turn
 * agree on the `included` set.
 */
export function selectInlineMemories(
  memories: Memory[],
  budgetBytes: number,
): { included: Memory[]; overflow: Memory[] } {
  // Reserve headroom for the section title/intro/headings so the RENDERED block
  // stays within budgetBytes (pinned are still never dropped, by design).
  const effectiveBudget = Math.max(0, budgetBytes - SECTION_OVERHEAD_BYTES);
  const pinned = memories.filter(m => m.pinned);
  const rest = memories.filter(m => !m.pinned);
  const included: Memory[] = [...pinned];
  const overflow: Memory[] = [];
  let bytes = pinned.reduce((sum, m) => sum + memoryBlockBytes(m), 0);
  for (const m of rest) {
    const b = memoryBlockBytes(m);
    if (bytes + b > effectiveBudget) { overflow.push(m); continue; }
    included.push(m);
    bytes += b;
  }
  return { included, overflow };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with', 'what',
  'how', 'do', 'does', 'did', 'can', 'could', 'you', 'your', 'i', 'me', 'my', 'we', 'it', 'its',
  'this', 'that', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'need', 'want', 'get', 'please',
  'about', 'from', 'when', 'which', 'who', 'why', 'not', 'any', 'all', 'so', 'if', 'then',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords + short tokens. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Jaccard similarity (0–1) of two texts' token sets — used by the reflection
 *  pass to detect near-duplicate memories (dedup → UPDATE instead of a twin). */
export function jaccard(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Rank memories by token overlap with the user's message and return the top-k
 * that fit the byte budget. The "needed sometime" tier: recall by keyword, no
 * embeddings. Returns [] when the query has no meaningful tokens or nothing matches.
 */
export function keywordRank(
  memories: Memory[],
  queryText: string,
  k: number,
  budgetBytes: number,
): Memory[] {
  const qTokens = tokenize(queryText);
  if (qTokens.size === 0) return [];
  const scored = memories
    .map(m => {
      const hay = tokenize(`${m.name} ${m.content}`);
      let score = 0;
      for (const t of qTokens) if (hay.has(t)) score += 1;
      return { m, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const out: Memory[] = [];
  let bytes = 0;
  for (const { m } of scored) {
    if (out.length >= k) break;
    const b = memoryBlockBytes(m);
    if (bytes + b > budgetBytes) continue;
    out.push(m);
    bytes += b;
  }
  return out;
}

/**
 * Render a set of memories as a markdown block, grouped by type (the same
 * formatting CLAUDE.md has always used). Returns null for an empty set.
 */
export function renderMemoryBlock(memories: Memory[], title: string, intro: string[]): string | null {
  if (memories.length === 0) return null;
  const groups: Record<Memory['type'], Memory[]> = { feedback: [], user: [], project: [], reference: [] };
  for (const m of memories) { if (groups[m.type]) groups[m.type].push(m); }

  const parts: string[] = [title, '', ...intro, ''];
  for (const type of TYPE_ORDER) {
    const rows = groups[type];
    if (rows.length === 0) continue;
    parts.push(`## ${TYPE_HEADINGS[type]}`);
    for (const m of rows) parts.push(`\n### ${m.name}\n${m.content.trim()}\n`);
    parts.push('');
  }
  return parts.join('\n');
}
