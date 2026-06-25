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

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Minus, X, Wrench, CheckCircle2, AlertTriangle, Brain, Clock,
  ShieldAlert, Copy, Check, Lock,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
// Values come from the pure sensitivity subpath, not the '@slackhive/shared' barrel,
// which would drag server/DB code + the persona catalog into this client bundle.
import {
  markSensitiveWith, SENS_COLOR, CAT_LABEL, humanizeTag,
  type SensitiveCategory as SensCategory, type SensScope, type ExtraMark,
} from '@slackhive/shared/sensitivity';
import type { TraceTurn, TraceSpan } from '@slackhive/shared';
import { formatTokens } from './formatTokens';
import { expandMarkdownHits } from '@/lib/markdown-hits';
import { cn } from '@/lib/utils';

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
      className={cn('rounded-[3px] px-1 font-semibold [box-decoration-break:clone] [-webkit-box-decoration-break:clone]', canReveal ? 'cursor-pointer' : 'cursor-not-allowed')}
      style={{
        background: `${color}26`, color,
        ...(llm ? { boxShadow: `inset 0 -2px 0 ${color}` } : {}),
      }}
    >
      {shown ? children : <span className="inline-flex items-center gap-[3px]">
        <Lock size={10} className="shrink-0" />{human.label}
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
  p: ({ children }) => <p className="mb-1.5 leading-[1.6]"><Hl>{children}</Hl></p>,
  ul: ({ children }) => <ul className="mb-1.5 pl-[18px] leading-[1.6]">{children}</ul>,
  ol: ({ children }) => <ol className="mb-1.5 pl-[18px] leading-[1.6]">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5"><Hl>{children}</Hl></li>,
  h1: ({ children }) => <h1 className="mt-1.5 mb-1 text-base font-semibold"><Hl>{children}</Hl></h1>,
  h2: ({ children }) => <h2 className="mt-1.5 mb-1 text-sm font-semibold"><Hl>{children}</Hl></h2>,
  h3: ({ children }) => <h3 className="mt-[5px] mb-[3px] text-sm font-semibold"><Hl>{children}</Hl></h3>,
  strong: ({ children }) => <strong><Hl>{children}</Hl></strong>,
  em: ({ children }) => <em><Hl>{children}</Hl></em>,
  table: ({ children }) => <div className="my-1 overflow-auto"><table className="border-collapse text-2xs">{children}</table></div>,
  th: ({ children }) => <th className="border border-border bg-secondary px-[7px] py-[3px] text-left font-semibold"><Hl>{children}</Hl></th>,
  td: ({ children }) => <td className="border border-border px-[7px] py-[3px]"><Hl>{children}</Hl></td>,
  code: ({ className, children, ...props }) => className?.startsWith('language-')
    ? <code className={cn(className, 'font-mono text-[11.5px]')} {...props}>{children}</code>
    : <code className="rounded-[3px] border border-border bg-secondary px-[5px] py-px font-mono text-[11.5px]" {...props}><Hl>{children}</Hl></code>,
  pre: ({ children }) => <pre className="my-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-2.5 text-[11.5px] leading-[1.5]">{children}</pre>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary"><Hl>{children}</Hl></a>,
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

const META = 'text-2xs text-muted-foreground shrink-0 font-mono tabular-nums';

/** Per-node kind → icon / colours, shared by the row and the detail drawer. */
function nodeVisuals(node: NodeData) {
  const isErr = node.kind === 'error' || !!node.error;
  const Icon = isErr ? AlertTriangle : node.kind === 'final' ? CheckCircle2 : node.kind === 'tool' ? Wrench : node.kind === 'event' ? Clock : Brain;
  return {
    isErr,
    Icon,
    tagColor: isErr ? 'text-red' : node.kind === 'final' ? 'text-green' : 'text-muted-foreground',
    barColor: isErr ? 'bg-red' : 'bg-muted-foreground',
    titleColor: node.kind === 'final' ? 'text-green' : isErr ? 'text-red' : 'text-foreground',
    accent: isErr ? 'var(--red)' as string : undefined,
  };
}

/** One observation row in the tree: pipe connector · ± toggle · type icon · name ·
 * model/tokens · a comparative duration bar · duration. Click opens the node's
 * content (args / result / reasoning) in the right-hand detail drawer. */
export function NodeRow({ node, maxMs, highlight, isLast }: { node: NodeData; maxMs: number; highlight?: boolean; isLast?: boolean }): React.JSX.Element {
  const has = node.sections.length > 0 || !!node.sensitive;
  const [isOpen, setIsOpen] = useState(!!node.defaultOpen || !!highlight);
  const rowRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(!!highlight);
  // Deep-linked span: scroll it into view, flash it, and open its drawer once.
  useEffect(() => {
    if (!highlight) return;
    rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (has) setIsOpen(true);
    const t = setTimeout(() => setFlash(false), 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for the highlighted span
  }, [highlight]);
  const { Icon, tagColor, barColor, titleColor } = nodeVisuals(node);

  const hasDur = node.durationMs != null;
  const pct = hasDur ? Math.max(2, Math.min(100, ((node.durationMs as number) / maxMs) * 100)) : 0;
  const durText = !hasDur ? '' : (node.durationMs && node.durationMs > 0 ? formatMs(node.durationMs) : '<1ms');

  return (
    <div id={`span-${node.key}`} ref={rowRef} className={cn('rounded-lg scroll-mt-20 transition-[box-shadow,background] duration-[400ms]', flash && 'shadow-[0_0_0_2px_var(--accent)] bg-secondary')}>
      <div className={cn('trace-node flex items-center gap-2 rounded-md py-1 pl-0 pr-2 min-h-[30px]', has ? 'cursor-pointer' : 'cursor-default', isOpen && 'bg-secondary')} onClick={() => has && setIsOpen(o => !o)}>
        {/* Tree pipe connector linking the rows into a single-level chain. */}
        <span aria-hidden className="relative self-stretch w-4 shrink-0">
          <span className="absolute left-2 top-0 w-px bg-border" style={{ bottom: isLast ? 'calc(50% - 0.5px)' : 0 }} />
          <span className="absolute left-2 w-1.5 h-px bg-border" style={{ top: 'calc(50% - 0.5px)' }} />
        </span>
        {/* ± expand affordance (boxed, IDE file-tree style). */}
        {has
          ? <span className={cn('inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 border border-border rounded-[3px]', isOpen ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}>
              {isOpen ? <Minus size={10} strokeWidth={2.5} /> : <Plus size={10} strokeWidth={2.5} />}
            </span>
          : <span className="w-3.5 shrink-0" />}
        <Icon size={13} className={cn('shrink-0', tagColor)} />
        <span className={cn('text-[12.5px] font-medium whitespace-nowrap overflow-hidden text-ellipsis flex-[0_1_auto] min-w-[60px]', titleColor, node.kind === 'generation' && node.title === 'Thinking' ? 'italic' : 'not-italic')}>{node.title}</span>
        {node.sensitive && <SensitiveBadge categories={node.sensitiveCategories ?? []} compact llm={node.sensitiveLlm} />}
        <div className="flex-1 min-w-2" />
        {node.model && <span className="text-2xs text-muted-foreground shrink-0 whitespace-nowrap">{node.model}</span>}
        {node.tokens > 0 && <span className={META}>{formatTokens(node.tokens)}</span>}
        <div className="shrink-0 w-[140px]">
          {hasDur && (
            <div className="h-1.5 bg-secondary rounded-[3px] overflow-hidden">
              <div title={durText} className={cn('h-full rounded-[3px] opacity-55', barColor)} style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <span className={cn(META, 'min-w-[50px] text-right')} title={hasDur && !(node.durationMs && node.durationMs > 0) ? 'Instant / not reported by backend' : undefined}>{durText}</span>
      </div>
      {isOpen && has && (
        <div className="ml-10 mr-2 mb-2 rounded-lg border border-border bg-card px-3 py-3 shadow-sm">
          {node.error && (
            <div className="mb-2.5 whitespace-pre-wrap break-words text-xs text-red">{node.error}</div>
          )}
          <NodeDetailBody node={node} />
        </div>
      )}
    </div>
  );
}

/** Renders a node's full content (args / result / reasoning) — used inside the
 * detail drawer. Shares the masking-aware {@link Content} with the old inline view. */
function NodeDetailBody({ node }: { node: NodeData }): React.JSX.Element {
  const { accent } = nodeVisuals(node);
  const last = node.sections.length - 1;
  return (
    <div className="flex flex-col gap-2.5 flex-1 min-h-0">
      {node.sections.map((s, i) => <Content key={i} label={s.label} body={s.body} markdown={s.markdown} accent={accent} sensitive={node.sensitive} scope={node.kind === 'tool' ? 'all' : 'text'} llmHits={node.sensitiveLlmHits} fill={i === last} />)}
      {node.sensitive && <SensitiveNote categories={node.sensitiveCategories ?? []} hits={node.sensitiveLlmHits ?? []} llm={node.sensitiveLlm} />}
    </div>
  );
}

type NodeDetailValue = { openKey: string | null; open: (node: NodeData) => void; close: () => void };
const NodeDetailCtx = React.createContext<NodeDetailValue>({ openKey: null, open: () => {}, close: () => {} });

/** Wraps a node tree (and any number of {@link NodeRow}s) so clicking a node opens
 * its content in a single shared right-hand drawer. Render it inside the same
 * {@link RevealCtx} provider as the rows so admin-reveal works in the drawer too. */
export function NodeDetailProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [node, setNode] = useState<NodeData | null>(null);
  const open = useCallback((n: NodeData) => setNode(cur => (cur && cur.key === n.key ? null : n)), []);
  const close = useCallback(() => setNode(null), []);
  const value = useMemo<NodeDetailValue>(() => ({ openKey: node?.key ?? null, open, close }), [node, open, close]);
  return (
    <NodeDetailCtx.Provider value={value}>
      {children}
      <NodeDetailDrawer node={node} onClose={close} />
    </NodeDetailCtx.Provider>
  );
}

/** Right slide-in panel showing the selected node's content. Closes on backdrop
 * click, the × button, or Escape. Portaled to <body> but kept inside the React
 * tree so {@link RevealCtx} (admin reveal) still applies. */
function NodeDetailDrawer({ node, onClose }: { node: NodeData | null; onClose: () => void }): React.JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  // Keep the last node during the slide-out so content doesn't vanish mid-animation.
  const [shown, setShown] = useState<NodeData | null>(node);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (node) {
      setShown(node);
      const r = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(r);
    }
    setVisible(false);
    const t = setTimeout(() => setShown(null), 220);
    return () => clearTimeout(t);
  }, [node]);
  useEffect(() => {
    if (!node) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [node, onClose]);

  if (!mounted || !shown) return null;
  const { Icon, tagColor, titleColor } = nodeVisuals(shown);
  const dur = shown.durationMs != null && shown.durationMs > 0 ? formatMs(shown.durationMs) : null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex justify-end">
      <div onClick={onClose} className="absolute inset-0 bg-black/30 transition-opacity duration-200 ease-in-out" style={{ opacity: visible ? 1 : 0 }} />
      <div role="dialog" aria-label={`${shown.title} detail`}
        className="relative w-[45%] min-w-[380px] max-w-[640px] self-stretch bg-card border-l border-border shadow-[-8px_0_28px_rgba(0,0,0,0.18)] transition-transform duration-[220ms] ease-in-out flex flex-col"
        style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}>
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-border shrink-0">
          <Icon size={15} className={cn('shrink-0', tagColor)} />
          <span className={cn('text-sm font-semibold whitespace-nowrap overflow-hidden text-ellipsis flex-1', titleColor)}>{shown.title}</span>
          {shown.sensitive && <SensitiveBadge categories={shown.sensitiveCategories ?? []} compact llm={shown.sensitiveLlm} />}
          {shown.model && <span className="text-2xs text-muted-foreground whitespace-nowrap">{shown.model}</span>}
          {shown.tokens > 0 && <span className={META}>{formatTokens(shown.tokens)}</span>}
          {dur && <span className={META}>{dur}</span>}
          <button onClick={onClose} title="Close (Esc)" className="inline-flex items-center cursor-pointer text-muted-foreground p-0.5 ml-0.5">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col p-3.5">
          {shown.error && (
            <div className="text-xs text-red mb-2.5 whitespace-pre-wrap break-words shrink-0">{shown.error}</div>
          )}
          <NodeDetailBody node={shown} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Section body: markdown for prose (thinking / answers / responses), pretty
 * code for tool args/results. Filled (not bordered) for a calmer look. */
function Content({ label, body, markdown, accent, sensitive, scope = 'all', llmHits, fill }: { label: string; body: string; markdown?: boolean; accent?: string; sensitive?: boolean; scope?: SensScope; llmHits?: ExtraMark[]; fill?: boolean }): React.JSX.Element {
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
  // In the drawer the body section grows to fill the panel and scrolls internally;
  // inline it stays capped so a long result doesn't dominate the trace list.
  const shellClass = cn('bg-secondary rounded-md px-2.5 py-2 overflow-auto', accent && 'border-l-2', fill ? 'flex-1 min-h-0' : 'max-h-[360px]');
  const accentStyle = accent ? { borderLeftColor: accent } : undefined;
  return (
    <div className={cn(fill && 'flex flex-col flex-1 min-h-0')}>
      <div className="flex items-center gap-1.5 mb-[3px]">
        <span className="text-[9.5px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">{label}</span>
        <button onClick={copy} title="Copy" className={cn('inline-flex items-center cursor-pointer p-0.5', copied ? 'text-green' : 'text-muted-foreground')}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      {markdown ? (
        <div className={cn(shellClass, 'text-[12.5px] text-foreground leading-[1.55]')} style={accentStyle}>
          <SensCtx.Provider value={sensitive ? scope : null}>
            <LlmHitsCtx.Provider value={mdHits}>
              <ReactMarkdown components={MD} remarkPlugins={[remarkGfm]}>{slackToMd(body)}</ReactMarkdown>
            </LlmHitsCtx.Provider>
          </SensCtx.Provider>
        </div>
      ) : (
        <pre className={cn(shellClass, 'm-0 text-2xs text-foreground font-mono whitespace-pre-wrap break-words')} style={accentStyle}>
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
    <span title={title} className="inline-flex items-center gap-1 text-amber text-2xs font-semibold tracking-[0.02em]">
      <span className="inline-flex items-start">
        <ShieldAlert size={compact ? 12 : 13} />
        {llm && <sup className="text-[7px] font-bold leading-none ml-[0.5px]">AI</sup>}
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
    <div className="flex items-center gap-1.5 text-[11.5px] text-amber">
      <ShieldAlert size={12} className="shrink-0" />
      <span>Flagged{suffix}: {what}</span>
    </div>
  );
}
