/**
 * @fileoverview Extract a JSON object from an LLM reply, tolerating the common
 * ways models wrap it: raw JSON, a ```json fenced block, or prose around a single
 * top-level object. Shared so a robustness fix lands in one place instead of the
 * copies that used to live in memory-extraction / memory-reconcile / analyze.
 *
 * @module runner/llm-json
 */
export function parseLlmJson<T = Record<string, unknown>>(reply: string): T | null {
  const strategies: (() => unknown)[] = [
    () => JSON.parse(reply),
    () => { const m = reply.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i); return m ? JSON.parse(m[1]) : null; },
    () => { const s = reply.indexOf('{'); const e = reply.lastIndexOf('}'); return s >= 0 && e > s ? JSON.parse(reply.slice(s, e + 1)) : null; },
  ];
  for (const strat of strategies) {
    try { const v = strat(); if (v && typeof v === 'object') return v as T; } catch { /* try next */ }
  }
  return null;
}
