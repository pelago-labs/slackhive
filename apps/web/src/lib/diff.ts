/**
 * @fileoverview LCS-based line diff utility.
 *
 * Extracted from the agent detail page so it can be imported in Node
 * test environments without pulling in React/Next.js dependencies.
 *
 * @module web/lib/diff
 */

/** A single line in a diff result, annotated with its change type. */
export type DiffLine = { type: 'same' | 'add' | 'remove'; line: string };

/**
 * Computes a line-level diff between two text strings using the
 * Longest Common Subsequence algorithm.
 *
 * @param {string} oldText - The original text.
 * @param {string} newText - The updated text.
 * @returns {DiffLine[]} Ordered diff entries annotated as same/add/remove.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length, n = b.length;
  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  // Trace back
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'same', line: a[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', line: b[j - 1] }); j--;
    } else {
      result.unshift({ type: 'remove', line: a[i - 1] }); i--;
    }
  }
  return result;
}

/** A diff line tagged with the 1-based old/new line number it corresponds to.
 *  `oldNo` is null for pure additions; `newNo` is null for pure removals;
 *  `same` lines have both numbers set. Used by the GitHub-style diff renderer. */
export type NumberedDiffLine = DiffLine & { oldNo: number | null; newNo: number | null };

/** A hunk of changes plus up to `context` unchanged lines on each side.
 *  Mirrors the shape used by `@@ -oldStart,oldLines +newStart,newLines @@`
 *  headers in unified diffs. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: NumberedDiffLine[];
}

/**
 * Group a line diff into hunks: each hunk contains every contiguous change
 * plus up to `context` `same` lines on each side. Long runs of unchanged
 * lines between changes become gaps between hunks instead of being rendered.
 *
 * @param lines - Output of {@link lineDiff}.
 * @param context - Unchanged lines of context to keep around each change block.
 * @returns One hunk per change block, in order. Empty array if there are no changes.
 */
export function hunks(lines: DiffLine[], context = 3): DiffHunk[] {
  // First pass: number every line with its old/new line number.
  const numbered: NumberedDiffLine[] = [];
  let oldNo = 0, newNo = 0;
  for (const l of lines) {
    if (l.type === 'same')        { oldNo++; newNo++; numbered.push({ ...l, oldNo, newNo }); }
    else if (l.type === 'add')    { newNo++;           numbered.push({ ...l, oldNo: null, newNo }); }
    else                          { oldNo++;           numbered.push({ ...l, oldNo, newNo: null }); }
  }

  // Second pass: find the closed intervals [start,end] of every change run,
  // expand each by `context` on both sides, then merge overlaps.
  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  for (let i = 0; i < numbered.length; i++) {
    if (numbered[i].type === 'same') continue;
    const start = Math.max(0, i - context);
    // Extend j as long as we either stay inside the change run or the gap
    // between changes is small enough to merge into one hunk (<= 2*context).
    let j = i;
    while (j + 1 < numbered.length) {
      if (numbered[j + 1].type !== 'same') { j++; continue; }
      // Peek forward: is there another change within 2*context of j?
      let k = j + 1;
      while (k < numbered.length && numbered[k].type === 'same' && k - j <= 2 * context) k++;
      if (k < numbered.length && numbered[k].type !== 'same') { j = k; continue; }
      break;
    }
    i = j; // skip what we just consumed
    const end = Math.min(numbered.length - 1, j + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  // Third pass: materialize each range as a DiffHunk.
  return ranges.map(({ start, end }) => {
    const slice = numbered.slice(start, end + 1);
    const firstOld = slice.find(l => l.oldNo !== null)?.oldNo ?? 0;
    const firstNew = slice.find(l => l.newNo !== null)?.newNo ?? 0;
    const oldLines = slice.filter(l => l.type !== 'add').length;
    const newLines = slice.filter(l => l.type !== 'remove').length;
    return {
      oldStart: oldLines === 0 ? 0 : firstOld,
      oldLines,
      newStart: newLines === 0 ? 0 : firstNew,
      newLines,
      lines: slice,
    };
  });
}

/** Count pure add / remove lines. Cheap; safe to call per file on each render. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'remove') removed++;
  }
  return { added, removed };
}
