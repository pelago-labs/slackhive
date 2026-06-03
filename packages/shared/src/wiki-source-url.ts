/**
 * @fileoverview Shared guard for wiki sources: is a stored value a real fetchable
 * web address, or pasted inline content that landed in the `url` column? Used by
 * BOTH the web add-source route (to classify type at creation) and the runner's
 * build path (defensive self-heal). Keeping it in one place means the two agree.
 *
 * @module @slackhive/shared/wiki-source-url
 */

/**
 * True only for values fetch() can actually retrieve — an absolute http(s) URL on
 * a single line. Anything else (markdown, multi-line text, file paths, bare
 * words) is inline content and must NOT be passed to fetch().
 */
export function isFetchableUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (/\s/.test(v)) return false; // multi-line / has whitespace ⇒ not a URL
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
