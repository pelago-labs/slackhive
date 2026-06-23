'use client';

/**
 * @fileoverview Masking-aware rendering of a turn's observation tree
 * (reasoning → tool calls → final answer), shared by the session-trace page and
 * the Observability "Audit" Turn view so the sensitive-masking logic lives in one
 * place. Values are masked by default; only an admin (via {@link RevealCtx}) can
 * click to reveal — for non-admins the raw value is already redacted server-side.
 *
 * @module web/app/activity/_components/trace-nodes
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight, ChevronDown, Wrench, CheckCircle2, AlertTriangle, Brain, Clock,
  ShieldAlert, Copy, Check, Lock,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
// Values come from the pure sensitivity subpath, not the '@slackhive/shared' barrel,
// which would drag server/DB code + the persona catalog into this client bundle.
import {
  markSensitiveWith, SENS_COLOR, CAT_LABEL, humanizeTag,
  type SensitiveCategory as SensCategory, type SensScope, type ExtraMark,
} from '@slackhive/shared/dist/sensitivity';
import type { TraceTurn, TraceSpan } from '@slackhive/shared';
import { formatTokens } from './formatTokens';
import { expandMarkdownHits } from '@/lib/markdown-hits';

/** Elapsed-time formatter for trace node durations. */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60); const rem = Math.round(s - m * 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/** True when the viewer may reveal raw sensitive values (admins only). */
export const RevealCtx = React.createContext(false);

/** A sensitive value, MASKED by default (shown as its kind, e.g. "Phone number").
 *  Admins can click to reveal/hide the real value; non-admins only ever see the
 *  masked label. */
function SensitiveMark({ cat, label, llm, children }: { cat: SensCategory; label: string; llm?: boolean; children: React.ReactNode }): React.JSX.Element {
  const canReveal = React.useContext(RevealCtx);
  const [revealed, setRevealed] = useState(false);
  // Only mask actual VALUES (PII / secrets) and LLM-found excerpts. The data:/tool:
  // categories are keyword/path LABELS (e.g. "payment", "cvv", ".env"), not values —
  // masking those common words is pure noise, so render them as plain text.
  if (!llm && cat !== 'secret' && cat !== 'pii') return <>{children}</>;
  const color = SENS_COLOR[cat];
  const human = humanizeTag(label);
  const shown = revealed && canReveal;
  const onClick = (e: React.MouseEvent) => { e.stopPropagation(); if (canReveal) setRevealed(r => !r); };
  const kindNote = llm ? `${catLabel(cat)} · caught by LLM` : catLabel(cat);
  return (
    <mark
      onClick={onClick}
      title={canReveal ? (shown ? 'Click to hide' : `Click to reveal (${kindNote})`) : `Hidden — admins only (${kindNote})`}
      style={{
        background: `${color}26`, color, borderRadius: 3, padding: '0 4px', fontWeight: 600,
        cursor: canReveal ? 'pointer' : 'not-allowed', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone',
        ...(llm ? { boxShadow: `inset 0 -2px 0 ${color}` } : {}),
      }}
    >
      {shown ? children : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <Lock size={10} style={{ flexShrink: 0 }} />{human.label}
      </span>}
    </mark>
  );
}

// When set (sensitive section), wrap text runs in marks for matched PII/secrets/
// data — so the agent's own answer (rendered as markdown) highlights like tool I/O.
// The context value is the highlight scope ('all' for tool I/O, 'text' for prose),
// or null when off.
const SensCtx = React.createContext<SensScope | null>(null);
// LLM-detector excerpts to also highlight inline (regex can't re-match these).
const EMPTY_HITS: ExtraMark[] = [];
const LlmHitsCtx = React.createContext<ExtraMark[]>(EMPTY_HITS);
function Hl({ children }: { children: React.ReactNode }): React.JSX.Element {
  const scope = React.useContext(SensCtx);
  const llmHits = React.useContext(LlmHitsCtx);
  if (!scope) return <>{children}</>;
  return <>{React.Children.map(children, (child) =>
    typeof child === 'string'
      ? markSensitiveWith(child, scope, llmHits).map((seg, i) => seg.cat
          ? <SensitiveMark key={i} cat={seg.cat} label={seg.label ?? seg.cat} llm={seg.llm}>{seg.text}</SensitiveMark>
          : <React.Fragment key={i}>{seg.text}</React.Fragment>)
      : child)}</>;
}

/** Normalize Slack mrkdwn the agent emitted so the trace renders it like Slack
 * did, not as literal GitHub markdown. Most visibly, a Slack link `<url|label>`
 * carries the value twice (in the url AND the label) — GH-markdown prints both,
 * which looked like a "duplicated" phone number; Slack shows only the label. */
function slackToMd(s: string): string {
  return s
    .replace(/<((?:https?|mailto|tel):[^|>\s]+)\|([^>]+)>/gi, '$2')
    .replace(/<((?:https?|mailto|tel):[^|>\s]+)>/gi, '$1')
    .replace(/<[@#!][^|>]+\|([^>]+)>/g, '$1')
    .replace(/<[@#!]([^|>]+)>/g, '@$1')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\*)/g, '$1**$2**')
    .replace(/(^|[^~])~(?=\S)([^~\n]+?)(?<=\S)~(?!~)/g, '$1~~$2~~');
}

/** Compact markdown styling for reasoning / answers inside trace nodes. */
const MD: Components = {
  p: ({ children }) => <p style={{ margin: '0 0 6px', lineHeight: 1.6 }}><Hl>{children}</Hl></p>,
  ul: ({ children }) => <ul style={{ margin: '0 0 6px', paddingLeft: 18, lineHeight: 1.6 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 6px', paddingLeft: 18, lineHeight: 1.6 }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 2 }}><Hl>{children}</Hl></li>,
  h1: ({ children }) => <h1 style={{ fontSize: 14, fontWeight: 600, margin: '6px 0 4px' }}><Hl>{children}</Hl></h1>,
  h2: ({ children }) => <h2 style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 4px' }}><Hl>{children}</Hl></h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 13, fontWeight: 600, margin: '5px 0 3px' }}><Hl>{children}</Hl></h3>,
  strong: ({ children }) => <strong><Hl>{children}</Hl></strong>,
  em: ({ children }) => <em><Hl>{children}</Hl></em>,
  table: ({ children }) => <div style={{ overflow: 'auto', margin: '4px 0 8px' }}><table style={{ borderCollapse: 'collapse', fontSize: 11 }}>{children}</table></div>,
  th: ({ children }) => <th style={{ border: '1px solid var(--border)', padding: '3px 7px', background: 'var(--surface-2)', textAlign: 'left', fontWeight: 600 }}><Hl>{children}</Hl></th>,
  td: ({ children }) => <td style={{ border: '1px solid var(--border)', padding: '3px 7px' }}><Hl>{children}</Hl></td>,
  code: ({ className, children, ...props }) => className?.startsWith('language-')
    ? <code className={className} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }} {...props}>{children}</code>
    : <code style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px', fontSize: 11.5, fontFamily: 'var(--font-mono)' }} {...props}><Hl>{children}</Hl></code>,
  pre: ({ children }) => <pre style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, margin: '4px 0 6px', fontSize: 11.5, lineHeight: 1.5, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{children}</pre>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}><Hl>{children}</Hl></a>,
};

/** Humanize a `category:detail` tag, falling back to the category label for a
 * bare category (e.g. "pii" -> "Personal info" rather than "pii"). */
export function catLabel(tag: string): string {
  const h = humanizeTag(tag);
  return h.label === h.category ? (CAT_LABEL[h.category] ?? h.label) : h.label;
}

// ── Observation node ─────────────────────────────────────────────────────────
export type NodeKind = 'generation' | 'tool' | 'event' | 'final' | 'error';
interface NodeSection { label: string; body: string; markdown?: boolean }
export interface NodeData {
  key: string;
  kind: NodeKind;
  title: string;
  model: string | null;
  startMs?: number;
  endMs?: number | null;
  durationMs: number | null;
  tokens: number;
  costUsd: number;
  error?: boolean;
  sections: NodeSection[];
  defaultOpen?: boolean;
  sensitive?: boolean;
  sensitiveCategories?: string[];
  sensitiveLlm?: boolean;
  sensitiveLlmHits?: ExtraMark[];
}

/** Flatten a turn into ordered tree nodes: each span, then the final answer,
 * then an error node (if any). */
export function buildNodes(turn: TraceTurn): NodeData[] {
  const nodes: NodeData[] = [];
  const finalTrim = turn.finalAnswer?.trim();
  const toExtra = (hits?: TraceSpan['sensitiveLlmHits']): ExtraMark[] =>
    (hits ?? []).map(h => ({ text: h.text, cat: h.category as SensCategory, label: h.label }));
  let answerGen: { sensitive?: boolean; cats?: string[]; spanId?: string; llm?: boolean; hits?: ExtraMark[] } | null = null;
  for (const sp of turn.spans) {
    if (sp.kind === 'generation') {
      if (finalTrim && sp.output && sp.output.trim() === finalTrim) {
        answerGen = { sensitive: sp.sensitive, cats: sp.sensitiveCategories, spanId: sp.spanId, llm: sp.sensitiveLlm, hits: toExtra(sp.sensitiveLlmHits) };
        continue;
      }
      if (!sp.reasoning && !sp.output) continue;
    }
    const sections: NodeSection[] = [];
    if (sp.reasoning) sections.push({ label: 'thinking', body: sp.reasoning, markdown: true });
    if (sp.input) sections.push({ label: sp.kind === 'tool' ? 'args' : 'input', body: sp.input });
    if (sp.output) sections.push({ label: sp.status === 'error' ? 'error' : sp.kind === 'tool' ? 'result' : 'output', body: sp.output, markdown: sp.kind === 'generation' });
    const title = sp.kind === 'tool' ? (sp.toolName ?? sp.name)
      : sp.kind === 'generation' ? (sp.output ? 'Response' : sp.reasoning ? 'Thinking' : 'Generation')
      : sp.name;
    nodes.push({
      key: sp.spanId,
      kind: sp.kind as NodeKind,
      title,
      model: sp.kind === 'generation' ? sp.model : null,
      startMs: sp.startMs,
      endMs: sp.endMs,
      durationMs: sp.durationMs,
      tokens: (sp.inputTokens ?? 0) + (sp.outputTokens ?? 0),
      costUsd: sp.costUsd ?? 0,
      error: sp.status === 'error',
      sections,
      sensitive: sp.sensitive,
      sensitiveCategories: sp.sensitiveCategories,
      sensitiveLlm: sp.sensitiveLlm,
      sensitiveLlmHits: toExtra(sp.sensitiveLlmHits),
    });
  }
  if (turn.finalAnswer) {
    nodes.push({
      key: answerGen?.spanId ?? '__final', kind: 'final', title: 'Final answer', model: null, durationMs: null,
      tokens: 0, costUsd: 0, sections: [{ label: 'answer', body: turn.finalAnswer, markdown: true }], defaultOpen: true,
      sensitive: answerGen?.sensitive, sensitiveCategories: answerGen?.cats, sensitiveLlm: answerGen?.llm, sensitiveLlmHits: answerGen?.hits,
    });
  }
  if (turn.error) {
    nodes.push({
      key: '__error', kind: 'error', title: 'Error', model: null, durationMs: null,
      tokens: 0, costUsd: 0, sections: [{ label: 'error', body: turn.error }], defaultOpen: true,
    });
  }
  return nodes;
}

const META = { fontSize: 11, color: 'var(--subtle)', flexShrink: 0, fontFamily: 'var(--font-mono, monospace)', fontVariantNumeric: 'tabular-nums' } as const;

/** One observation row: chevron · type icon · name · model/tokens · a comparative
 * duration bar · duration. Click to expand its content. */
export function NodeRow({ node, maxMs, highlight }: { node: NodeData; maxMs: number; highlight?: boolean }): React.JSX.Element {
  const has = node.sections.length > 0;
  const [open, setOpen] = useState(!!node.defaultOpen || !!highlight);
  const rowRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(!!highlight);
  useEffect(() => {
    if (!highlight) return;
    rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setFlash(false), 2600);
    return () => clearTimeout(t);
  }, [highlight]);
  const isErr = node.kind === 'error' || node.error;
  const Icon = isErr ? AlertTriangle : node.kind === 'final' ? CheckCircle2 : node.kind === 'tool' ? Wrench : node.kind === 'event' ? Clock : Brain;
  const tagColor = isErr ? 'var(--red)' : node.kind === 'final' ? 'var(--green)' : 'var(--muted)';
  const barColor = isErr ? 'var(--red)' : 'var(--text-2)';
  const titleColor = node.kind === 'final' ? 'var(--green)' : isErr ? 'var(--red)' : 'var(--text)';
  const accent = isErr ? 'var(--red)' : undefined;

  const hasDur = node.durationMs != null;
  const pct = hasDur ? Math.max(2, Math.min(100, ((node.durationMs as number) / maxMs) * 100)) : 0;
  const durText = !hasDur ? '' : (node.durationMs && node.durationMs > 0 ? formatMs(node.durationMs) : '<1ms');

  return (
    <div id={`span-${node.key}`} ref={rowRef} style={{ borderRadius: 8, scrollMarginTop: 80, transition: 'box-shadow 0.4s, background 0.4s', ...(flash ? { boxShadow: '0 0 0 2px var(--accent)', background: 'var(--surface-2)' } : {}) }}>
      <div className="trace-node" onClick={() => has && setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', borderRadius: 6, minHeight: 30, cursor: has ? 'pointer' : 'default' }}>
        {has
          ? (open ? <ChevronDown size={13} style={{ color: 'var(--subtle)', flexShrink: 0 }} /> : <ChevronRight size={13} style={{ color: 'var(--subtle)', flexShrink: 0 }} />)
          : <span style={{ width: 13, flexShrink: 0 }} />}
        <Icon size={13} style={{ flexShrink: 0, color: tagColor }} />
        <span style={{ fontSize: 12.5, fontWeight: 500, color: titleColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto', minWidth: 60, fontStyle: node.kind === 'generation' && node.title === 'Thinking' ? 'italic' : 'normal' }}>{node.title}</span>
        {node.sensitive && <SensitiveBadge categories={node.sensitiveCategories ?? []} compact llm={node.sensitiveLlm} />}
        <div style={{ flex: 1, minWidth: 8 }} />
        {node.model && <span style={{ fontSize: 10, color: 'var(--subtle)', flexShrink: 0, whiteSpace: 'nowrap' }}>{node.model}</span>}
        {node.tokens > 0 && <span style={META}>{formatTokens(node.tokens)}</span>}
        <div style={{ flexShrink: 0, width: 140 }}>
          {hasDur && (
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
              <div title={durText} style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3, opacity: 0.55 }} />
            </div>
          )}
        </div>
        <span style={{ ...META, minWidth: 50, textAlign: 'right' }} title={hasDur && !(node.durationMs && node.durationMs > 0) ? 'Instant / not reported by backend' : undefined}>{durText}</span>
      </div>
      {open && has && (
        <div style={{ paddingLeft: 24, paddingRight: 4, paddingBottom: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {node.sections.map((s, i) => <Content key={i} label={s.label} body={s.body} markdown={s.markdown} accent={accent} sensitive={node.sensitive} scope={node.kind === 'tool' ? 'all' : 'text'} llmHits={node.sensitiveLlmHits} />)}
          {node.sensitive && <SensitiveNote categories={node.sensitiveCategories ?? []} hits={node.sensitiveLlmHits ?? []} llm={node.sensitiveLlm} />}
        </div>
      )}
    </div>
  );
}

/** Section body: markdown for prose (thinking / answers / responses), pretty
 * code for tool args/results. Filled (not bordered) for a calmer look. */
function Content({ label, body, markdown, accent, sensitive, scope = 'all', llmHits }: { label: string; body: string; markdown?: boolean; accent?: string; sensitive?: boolean; scope?: SensScope; llmHits?: ExtraMark[] }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const hits = llmHits ?? EMPTY_HITS;
  let text = body;
  if (!markdown) {
    try { const t = body.trim(); if (t.startsWith('{') || t.startsWith('[')) text = JSON.stringify(JSON.parse(t), null, 2); } catch { /* raw */ }
  }
  const hitsKey = hits.map(h => `${h.text}${h.cat}${h.label}`).join('');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hitsKey is the value-stable proxy for `hits`
  const segments = useMemo(() => (sensitive && !markdown ? markSensitiveWith(text, scope, hits) : null), [sensitive, markdown, text, scope, hitsKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hitsKey is the value-stable proxy for `hits`
  const mdHits = useMemo(() => expandMarkdownHits(hits), [hitsKey]);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  };
  const shell: React.CSSProperties = {
    background: 'var(--surface-2)', borderRadius: 6, padding: '8px 10px',
    borderLeft: accent ? `2px solid ${accent}` : undefined,
    maxHeight: 360, overflow: 'auto',
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.07em', color: 'var(--subtle)', textTransform: 'uppercase' }}>{label}</span>
        <button onClick={copy} title="Copy" style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: copied ? 'var(--green)' : 'var(--subtle)', padding: 2 }}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      {markdown ? (
        <div style={{ ...shell, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.55 }}>
          <SensCtx.Provider value={sensitive ? scope : null}>
            <LlmHitsCtx.Provider value={mdHits}>
              <ReactMarkdown components={MD} remarkPlugins={[remarkGfm]}>{slackToMd(body)}</ReactMarkdown>
            </LlmHitsCtx.Provider>
          </SensCtx.Provider>
        </div>
      ) : (
        <pre style={{ ...shell, margin: 0, fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {segments
            ? segments.map((seg, i) => seg.cat
                ? <SensitiveMark key={i} cat={seg.cat} label={seg.label ?? seg.cat} llm={seg.llm}>{seg.text}</SensitiveMark>
                : <React.Fragment key={i}>{seg.text}</React.Fragment>)
            : text}
        </pre>
      )}
    </div>
  );
}

/** Shield badge for a span/turn; "AI" superscript when the Smart detector caught it. */
export function SensitiveBadge({ categories, compact, llm }: { categories: string[]; compact?: boolean; llm?: boolean }): React.JSX.Element {
  const cats = categories.length ? categories.join(', ') : 'data touched';
  const title = llm ? `Sensitive (caught by the Smart LLM detector): ${cats}` : `Sensitive: ${cats}`;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      color: '#b45309', fontSize: 10, fontWeight: 600, letterSpacing: '0.02em',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'flex-start' }}>
        <ShieldAlert size={compact ? 12 : 13} />
        {llm && <sup style={{ fontSize: 7, fontWeight: 700, lineHeight: 1, marginLeft: 0.5 }}>AI</sup>}
      </span>
      {compact ? null : 'Sensitive'}
    </span>
  );
}

/** One line under the node content naming the TYPE(S) of data flagged (values are
 * already masked above, so this never repeats them). */
export function SensitiveNote({ categories, hits, llm }: { categories: string[]; hits: ExtraMark[]; llm?: boolean }): React.JSX.Element {
  const suffix = llm ? ' (caught by the Smart detector)' : '';
  const cap = (s: string): string => s.replace(/^\w/, c => c.toUpperCase());
  const labels = [...new Set(
    (hits.length ? hits.map(h => h.label) : categories).map(t => cap(catLabel(t))),
  )].filter(Boolean);
  const what = labels.length ? labels.join(', ') : 'sensitive data';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#b45309' }}>
      <ShieldAlert size={12} style={{ flexShrink: 0 }} />
      <span>Flagged{suffix}: {what}</span>
    </div>
  );
}
