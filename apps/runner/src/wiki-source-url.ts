/**
 * @fileoverview Tiny guard for the wiki source builder: decide whether a `url`
 * source's stored value is a real fetchable web address or pasted inline content
 * that landed in the wrong column. Blindly `fetch()`-ing inline markdown throws
 * "Failed to parse URL" and silently drops the source from the wiki — this is the
 * check that prevents that.
 *
 * @module runner/wiki-source-url
 */

/**
 * True only for values fetch() can actually retrieve — an absolute http(s) URL on
 * a single line. Anything else (markdown, multi-line text, file paths, bare
 * words) is treated as inline content by the caller.
 */
export function isFetchableUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  // Multi-line ⇒ definitely not a URL (pasted document).
  if (/\s/.test(v)) return false;
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
