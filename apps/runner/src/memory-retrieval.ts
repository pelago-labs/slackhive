/**
 * @fileoverview Per-turn memory selection + rendering helpers.
 *
 * Memories are injected at ONE layer — per turn, in buildPrompt — so there is a
 * single source of truth (no CLAUDE.md memory cache, no recompile-on-write, no
 * compile/turn selector agreement). selectForPrompt picks what this sender sees:
 * pinned + memories scoped to them, then the most relevant globals within a byte
 * budget. renderMemoryBlock formats them; jaccard/tokenize back the extraction
 * dedup.
 *
 * @module runner/memory-retrieval
 */
import type { Memory } from '@slackhive/shared';

/** Byte budget for the whole per-turn memory block. */
export const MAX_MEMORY_PROMPT_BYTES = 32 * 1024;

const TYPE_ORDER: Memory['type'][] = ['feedback', 'user', 'project', 'reference'];
const TYPE_HEADINGS: Record<Memory['type'], string> = {
  feedback: 'Feedback (behavioral rules — apply unconditionally)',
  user: 'User (facts about people)',
  project: 'Project (current initiatives)',
  reference: 'Reference (domain knowledge)',
};

/** Byte cost of one memory as rendered (`### name` + body). */
function memoryBlockBytes(m: Memory): number {
  return Buffer.byteLength(`\n### ${m.name}\n${m.content.trim()}\n`, 'utf-8');
}

/** Reserve for the rendered section's title + intro + up to four `## ` headings,
 *  so the whole block (not just raw content) stays under the budget. */
const SECTION_OVERHEAD_BYTES = 800;

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
 * Choose the memories to inject for one turn, from THIS sender's perspective:
 *   - exclude memories scoped to someone else;
 *   - ALWAYS include pinned + memories scoped to this sender;
 *   - fill the remaining byte budget with global memories, most keyword-relevant
 *     to the message first (0-score globals still included when they fit, so a
 *     small set surfaces fully; the budget is the real limit for large sets).
 */
export function selectForPrompt(
  memories: Memory[],
  opts: { userId: string; groupIds: Set<string>; queryText: string; budgetBytes?: number },
): Memory[] {
  const budget = Math.max(0, (opts.budgetBytes ?? MAX_MEMORY_PROMPT_BYTES) - SECTION_OVERHEAD_BYTES);
  const scopedToSender = (m: Memory) => m.scopeUserId === opts.userId || (m.scopeGroupId != null && opts.groupIds.has(m.scopeGroupId));
  const isGlobal = (m: Memory) => !m.scopeUserId && !m.scopeGroupId;

  const visible = memories.filter(m => isGlobal(m) || scopedToSender(m));
  const priority = visible.filter(m => m.pinned || scopedToSender(m)); // always in
  const prioritySet = new Set(priority.map(m => m.id));
  const globals = visible.filter(m => !prioritySet.has(m.id));         // global, unpinned

  const out: Memory[] = [...priority];
  let bytes = priority.reduce((sum, m) => sum + memoryBlockBytes(m), 0);

  const qTokens = tokenize(opts.queryText);
  const ranked = globals
    .map(m => {
      const hay = tokenize(`${m.name} ${m.content}`);
      let score = 0;
      for (const t of qTokens) if (hay.has(t)) score += 1;
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const { m } of ranked) {
    const b = memoryBlockBytes(m);
    if (bytes + b > budget) continue;
    out.push(m);
    bytes += b;
  }
  return out;
}

/**
 * Render a set of memories as a markdown block, grouped by type. Returns null
 * for an empty set.
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
