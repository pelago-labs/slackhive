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
