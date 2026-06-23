/**
 * @fileoverview Prepare LLM-detector excerpts for highlighting against MARKDOWN-
 * rendered text in the session trace. Markdown both strips emphasis markers and
 * breaks an emphasized run into its own DOM text node, so a single excerpt may
 * straddle node boundaries and never match the on-screen text as one string. This
 * expands each excerpt into the fragments that will actually appear as contiguous
 * text nodes, so {@link markSensitiveWith} can still match (and mask) the value.
 *
 * Extracted from the trace page so the logic is unit-testable in isolation.
 *
 * @module web/lib/markdown-hits
 */
import type { ExtraMark } from '@slackhive/shared';

/**
 * Expand each excerpt into:
 *  - the whole cleaned excerpt (markup stripped),
 *  - each emphasis-delimited run (`*x*`, `_x_`, `~x~`, `` `x` ``) — markdown isolates
 *    these into their own text node,
 *  - each value-like numeric token — a table renders a flagged number in its own
 *    cell ("SGD 123,298.28 GMV" -> cell "123,298.28"), away from the surrounding
 *    words, so the full excerpt won't match there.
 *
 * To keep the numeric expansion targeted, a token only qualifies when it has a digit
 * AND looks like a real value: it carries a grouping separator (`.`/`,`) or is at
 * least 6 chars. This masks currency/ids/account numbers while NOT turning an
 * incidental bare year (e.g. "2024") into a broad hit that highlights every copy of
 * that number on the page. Results are deduped on (cat, label, text).
 */
export function expandMarkdownHits(hits: ExtraMark[]): ExtraMark[] {
  const out: ExtraMark[] = [];
  const seen = new Set<string>();
  const add = (h: ExtraMark, raw: string): void => {
    const text = raw.replace(/[*_~`]/g, '').trim();
    if (!text) return;
    const key = `${h.cat}|${h.label}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...h, text });
  };
  for (const h of hits) {
    add(h, h.text);
    for (const run of h.text.match(/\*([^*]+)\*|_([^_]+)_|~([^~]+)~|`([^`]+)`/g) ?? []) add(h, run);
    for (const tok of h.text.replace(/[*_~`]/g, ' ').split(/\s+/)) {
      const t = tok.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '');
      const looksLikeValue = t.length >= 6 || /[.,]/.test(t);
      if (t.length >= 4 && /\d/.test(t) && looksLikeValue) add(h, t);
    }
  }
  return out;
}
