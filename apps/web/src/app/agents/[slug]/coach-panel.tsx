'use client';

/**
 * @fileoverview Coach — interactive chat to tune an agent's CLAUDE.md & skills.
 *
 * Slide-over panel on the right of the Instructions tab. Streams SSE from
 * /api/agents/[id]/coach; renders assistant text as chat bubbles, tool calls
 * as compact chips, and proposal tool calls as approval cards. In normal use,
 * Apply buttons hit the existing claude-md / skills routes. The new-agent
 * wizard fires a detached bootstrap turn that applies proposals server-side;
 * this panel then polls until the "drafting" snapshot resolves.
 *
 * @module web/app/agents/[slug]/coach-panel
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, Send, Loader2, RotateCcw, Wand2, ChevronDown, ChevronRight, Check, FileText, History, ArrowLeft, Download, BookOpen } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CoachMessage, CoachProposal, Skill, Memory } from '@slackhive/shared';

/** Shape of one archived conversation returned by `/coach?archive=1`. */
interface ArchivedConversation {
  id: string;
  sdkSessionId?: string;
  messages: CoachMessage[];
  startedAt: string;
  archivedAt: string;
}

/** Browser uuid that doesn't require a secure context (HTTP dev, etc). */
const uid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** After this age a still-`inProgress` assistant message is treated as stale
 *  (runner probably crashed mid-turn). Keeps users from being stuck on a
 *  permanent "Drafting…" indicator. The server also heals stale rows at GET
 *  time; this client-side grace period just covers live in-flight streams. */
const STALE_DRAFT_MS = 30_000;

const isLiveDraft = (m: CoachMessage | undefined): boolean =>
  !!m && m.role === 'assistant' && m.inProgress === true
    && Date.now() - new Date(m.createdAt).getTime() < STALE_DRAFT_MS;

function patchProposal(
  messages: CoachMessage[],
  index: number,
  proposalId: string,
  status: 'applied' | 'rejected',
): CoachMessage[] {
  const msg = messages[index];
  if (!msg?.proposals) return messages;
  const proposals = msg.proposals.map(p =>
    p.id === proposalId ? ({ ...p, status } as CoachProposal) : p,
  );
  return [...messages.slice(0, index), { ...msg, proposals }, ...messages.slice(index + 1)];
}

/**
 * Context-aware quick-start prompts. Blank agents get "build from scratch"
 * prompts; agents that already have a persona or skills get audit/extend
 * prompts. No trailing ellipses — those read as truncated text when the
 * prompt lands in a bubble.
 */
function computeSuggestions({ hasClaudeMd, skillCount, memoryCount, agentName }: {
  hasClaudeMd: boolean; skillCount: number; memoryCount: number; agentName: string;
}): string[] {
  const blank = !hasClaudeMd && skillCount === 0;
  if (blank) {
    return [
      `Help me build ${agentName} from scratch`,
      'What does a great Slack agent look like?',
      'Diagnose a failed conversation',
    ];
  }
  // Memory review only makes sense once memories exist — it's the replacement
  // for the old Memory-tab "Analyze" button. Show it first so it's the most
  // prominent prompt when the agent has accumulated learned state.
  const base = [
    `Audit ${agentName}'s setup and flag what's weak`,
    `Draft a new skill for ${agentName}`,
    'Diagnose a failed conversation',
  ];
  if (memoryCount > 0) {
    return [`Audit ${agentName}'s memories — flag conflicts, duplicates, stale rules, and budget`, ...base.slice(0, 2)];
  }
  return base;
}

/**
 * Styled markdown element overrides for assistant bubbles. Keeps markdown
 * output visually tight and matched to the chat bubble — no oversized headings,
 * inline code chips on bubble background, `pre` blocks with a soft card look.
 */
const MD_COMPONENTS: Components = {
  p: ({ children }) => <p style={{ margin: '0 0 6px', lineHeight: 1.55 }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '0 0 6px', paddingLeft: 18, lineHeight: 1.55 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 6px', paddingLeft: 18, lineHeight: 1.55 }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
  h1: ({ children }) => <h1 style={{ fontSize: 14, fontWeight: 600, margin: '4px 0 4px' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: 13.5, fontWeight: 600, margin: '4px 0 4px' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 13, fontWeight: 600, margin: '4px 0 4px' }}>{children}</h3>,
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return (
        <code className={className} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 3,
          padding: '1px 5px',
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
        }}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 10,
        margin: '4px 0 6px',
        fontSize: 12,
        lineHeight: 1.5,
        overflow: 'auto',
        whiteSpace: 'pre',
      }}
    >
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '4px 0 6px' }}>
      <table style={{
        borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.5,
        width: '100%',
      }}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead style={{ background: 'var(--surface)' }}>{children}</thead>,
  th: ({ children }) => (
    <th style={{
      textAlign: 'left', padding: '6px 8px',
      borderBottom: '1px solid var(--border)',
      fontWeight: 600, color: 'var(--text)',
    }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{
      padding: '6px 8px',
      borderBottom: '1px solid var(--border)',
      verticalAlign: 'top',
    }}>{children}</td>
  ),
};

export function CoachPanel({
  agentId,
  agentName,
  open,
  onClose,
  canEdit,
}: {
  agentId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
  canEdit: boolean;
}) {
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // Agent context — lets us tailor quick-start suggestions to whether the
  // agent is blank or already set up. We fetch lazily on panel open.
  const [hasClaudeMd, setHasClaudeMd] = useState(false);
  const [skillCount, setSkillCount] = useState(0);
  const [memoryCount, setMemoryCount] = useState(0);
  // Full current content, used to compute diffs for UPDATE proposal cards.
  // We store the raw text/arrays so each ProposalCard can find its "before".
  const [currentClaudeMd, setCurrentClaudeMd] = useState<string>('');
  const [currentSkills, setCurrentSkills] = useState<Skill[]>([]);
  const [currentMemories, setCurrentMemories] = useState<Memory[]>([]);
  // History view state. `view: 'list'` shows archived conversations;
  // `view: 'archive'` shows one archived thread read-only; `view: 'current'`
  // is the default (live conversation).
  type View = { mode: 'current' } | { mode: 'list' } | { mode: 'archive'; archiveId: string };
  const [view, setView] = useState<View>({ mode: 'current' });
  const [archive, setArchive] = useState<ArchivedConversation[]>([]);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Controller for the in-flight SSE fetch. Used to abort cleanly when the
  // user clicks "New conversation" mid-stream (otherwise the reader hangs
  // until the server closes, `sending` stays true, and the composer is
  // permanently locked — see bug report).
  const abortRef = useRef<AbortController | null>(null);

  // Fetch agent context once per panel open for smart suggestions.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [mdRes, skRes, memRes] = await Promise.all([
          fetch(`/api/agents/${agentId}/claude-md`),
          fetch(`/api/agents/${agentId}/skills`),
          fetch(`/api/agents/${agentId}/memories`),
        ]);
        if (cancelled) return;
        if (mdRes.ok) {
          const md = await mdRes.text();
          setHasClaudeMd(!!md.trim());
          setCurrentClaudeMd(md);
        }
        if (skRes.ok) {
          const skills = await skRes.json();
          const arr: Skill[] = Array.isArray(skills) ? skills : [];
          setSkillCount(arr.length);
          setCurrentSkills(arr);
        }
        if (memRes.ok) {
          const mems = await memRes.json();
          const arr: Memory[] = Array.isArray(mems) ? mems : [];
          setMemoryCount(arr.length);
          setCurrentMemories(arr);
        }
      } catch { /* non-fatal — falls back to blank-agent suggestions */ }
    })();
    return () => { cancelled = true; };
  }, [open, agentId]);

  // Load the session on open, then keep polling while any assistant turn is
  // still in progress (e.g. wizard bootstrap). Polling stops as soon as the
  // tail message transitions out of `inProgress`, or after a hard timeout.
  // When drafting finishes, fire a global refresh event so the claude.md /
  // skills / memory sections re-fetch without a manual page reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let wasDrafting = false;
    const MAX_ATTEMPTS = 60; // ~2 minutes at 2s cadence

    const tick = async () => {
      try {
        const r = await fetch(`/api/agents/${agentId}/coach`);
        const d = await r.json();
        const next: CoachMessage[] = Array.isArray(d.messages) ? d.messages : [];
        if (cancelled) return;
        setMessages(next);
        const tail = next[next.length - 1];
        const stillDrafting = isLiveDraft(tail);
        if (wasDrafting && !stillDrafting) {
          window.dispatchEvent(new Event('slackhive:instructions-refresh'));
        }
        wasDrafting = stillDrafting;
        if (stillDrafting && attempts < MAX_ATTEMPTS) {
          attempts += 1;
          timer = setTimeout(tick, 2000);
        }
      } catch {
        if (!cancelled && attempts < MAX_ATTEMPTS) {
          attempts += 1;
          timer = setTimeout(tick, 3000);
        }
      }
    };
    tick();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [open, agentId]);

  // Sticky-bottom auto-scroll: only follow new content if the user is already
  // near the bottom. Lets them scroll up to read earlier turns while a long
  // stream continues, without being yanked back down every token.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight });
  }, [messages, sending]);

  const send = async (text: string) => {
    if (!text.trim() || sending) return;
    setError('');
    setSending(true);

    const userMsg: CoachMessage = {
      id: uid(),
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
    };
    const draft: CoachMessage = {
      id: uid(),
      role: 'assistant',
      text: '',
      toolCalls: [],
      proposals: [],
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg, draft]);
    setInput('');

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/agents/${agentId}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: text }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => '');
        throw new Error(t || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const ev of events) {
          const line = ev.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== 'assistant') return prev;
              let patched: Partial<CoachMessage> | null = null;
              if (payload.type === 'text') {
                patched = { text: (last.text ?? '') + payload.delta };
              } else if (payload.type === 'tool') {
                patched = { toolCalls: [...(last.toolCalls ?? []), { name: payload.name, input: payload.input, ok: payload.ok }] };
              } else if (payload.type === 'proposal') {
                patched = { proposals: [...(last.proposals ?? []), payload.proposal] };
              } else if (payload.type === 'error') {
                setError(payload.message);
              }
              return patched ? [...prev.slice(0, -1), { ...last, ...patched }] : prev;
            });
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      // AbortError is expected when the user clicks "New conversation"
      // mid-stream — it's a deliberate cancel, not a failure to surface.
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
  };

  /** Archive the current conversation and start a fresh one (non-destructive —
   *  the active row is moved into `coach-archive:<id>` before being cleared).
   *  If a turn is still streaming, abort the client fetch so the composer
   *  doesn't stay locked while the SSE reader drains. */
  const startNewConversation = async () => {
    const midStream = sending;
    const prompt = midStream
      ? 'Claude is still responding. Archive this conversation and start a new one anyway?'
      : 'Start a new conversation? The current one will be archived.';
    if (!confirm(prompt)) return;
    // Cancel the in-flight stream first so `sending` flips to false via the
    // send()'s finally block — otherwise the composer stays disabled until
    // the server closes the SSE stream on its own.
    if (abortRef.current) abortRef.current.abort();
    await fetch(`/api/agents/${agentId}/coach`, { method: 'DELETE' });
    setMessages([]);
    setError('');
    setView({ mode: 'current' });
    // Force a refetch next time the user opens History so the just-archived
    // thread shows up without a manual reload.
    setArchiveLoaded(false);
  };

  /** Fetch the archive list on demand. Cached per panel-open via `archiveLoaded`. */
  const loadArchive = async () => {
    try {
      const r = await fetch(`/api/agents/${agentId}/coach?archive=1`);
      if (!r.ok) return;
      const d = await r.json();
      setArchive(Array.isArray(d.archive) ? d.archive : []);
      setArchiveLoaded(true);
    } catch { /* non-fatal — empty state is fine */ }
  };

  const openHistory = () => {
    setView({ mode: 'list' });
    if (!archiveLoaded) void loadArchive();
  };

  const applyProposal = async (messageIndex: number, proposal: CoachProposal) => {
    if (!canEdit) return;
    // Wiki-extract proposals have no store edit to apply — the UI exposes only
    // a Download button for them, so this branch exists to satisfy the type
    // narrowing below in case `onApply` is ever wired up accidentally.
    if (proposal.kind === 'wiki-extract') return;
    let res: Response;
    if (proposal.kind === 'claude-md') {
      res = await fetch(`/api/agents/${agentId}/claude-md`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: proposal.content,
      });
    } else if (proposal.kind === 'memory') {
      // Memory proposals:
      //   create → POST /memories with type + name + content (new row).
      //   update → POST /memories with the existing row's name (upsert by name).
      //            If the proposal includes memoryType, use it (retype); otherwise
      //            preserve the existing row's type.
      //   delete → DELETE /memories/[memId].
      // Note: inlined memories in CLAUDE.md only refresh on agent restart.
      if (proposal.action === 'delete') {
        if (!proposal.memoryId) { setError('memory proposal missing id'); return; }
        res = await fetch(`/api/agents/${agentId}/memories/${proposal.memoryId}`, { method: 'DELETE' });
      } else if (proposal.action === 'create') {
        res = await fetch(`/api/agents/${agentId}/memories`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: proposal.memoryType,
            name: proposal.memoryName,
            content: proposal.content,
          }),
        });
      } else {
        const memRes = await fetch(`/api/agents/${agentId}/memories`);
        const mems = await memRes.json() as { id: string; type: string; name: string }[];
        const hit = mems.find(m => m.id === proposal.memoryId);
        if (!hit) { setError('memory not found'); return; }
        res = await fetch(`/api/agents/${agentId}/memories`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: proposal.memoryType ?? hit.type,
            name: hit.name,
            content: proposal.content,
          }),
        });
      }
    } else if (proposal.action === 'delete') {
      // Delete flow needs the skill id — look it up.
      const sr = await fetch(`/api/agents/${agentId}/skills`);
      const skills = await sr.json() as { id: string; category: string; filename: string }[];
      const hit = skills.find(s => s.category === proposal.category && s.filename === proposal.filename);
      if (!hit) { setError('skill not found'); return; }
      res = await fetch(`/api/agents/${agentId}/skills/${hit.id}`, { method: 'DELETE' });
    } else {
      res = await fetch(`/api/agents/${agentId}/skills`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: proposal.category, filename: proposal.filename, content: proposal.content }),
      });
    }
    if (!res.ok) { setError(await res.text().catch(() => `HTTP ${res.status}`)); return; }

    await fetch(`/api/agents/${agentId}/coach`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: proposal.id, status: 'applied' }),
    });

    setMessages(prev => patchProposal(prev, messageIndex, proposal.id, 'applied'));
    window.dispatchEvent(new Event('slackhive:instructions-refresh'));
  };

  const rejectProposal = async (messageIndex: number, proposal: CoachProposal) => {
    await fetch(`/api/agents/${agentId}/coach`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: proposal.id, status: 'rejected' }),
    });
    setMessages(prev => patchProposal(prev, messageIndex, proposal.id, 'rejected'));
  };

  // Close on Escape + lock page scroll behind the panel. Cursor-style: the
  // page beneath the slide-over should not move while the panel is open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      // Abort any in-flight SSE stream when the panel closes — otherwise
      // the reader hangs until the server closes, and reopening the panel
      // inherits a locked composer (`sending: true`) from the orphan fetch.
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  // Block the composer while an assistant turn is still being drafted server-side.
  const bootstrapDrafting = isLiveDraft(messages[messages.length - 1]);
  const composerDisabled = !canEdit || sending || bootstrapDrafting;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          // Stronger backdrop for proper separation — light mode gets a soft
          // darken, dark mode gets noticeably more dim so the elevated panel
          // reads as a distinct surface against the page behind.
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 49,
          backdropFilter: 'blur(2px)',
          animation: 'fadeIn 0.15s ease-out',
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Coach — tuning ${agentName}`}
        style={{
          // Explicit height: 100vh + top: 0 belt-and-suspenders — some browsers
          // don't resolve `top: 0 + bottom: 0` during the slide-in animation,
          // causing the composer to land below the viewport.
          position: 'fixed', top: 0, right: 0, height: '100vh', width: 520, maxWidth: '100vw', zIndex: 50,
          // `--surface-2` is one step elevated from the page background — the
          // panel reads as a distinct card in both light and dark themes. The
          // strong left border + shadow seal the boundary.
          background: 'var(--surface-2)', borderLeft: '1px solid var(--border-2, var(--border))',
          display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--shadow-modal, -12px 0 36px rgba(0,0,0,0.18))',
          animation: 'slideInRight 0.18s ease-out',
        }}
      >
        {/* Header — wand icon + stacked label on the left ("Coach" over
            "tuning {agentName}"); icon buttons on the right. The subtitle
            stays because the agent name is easily lost once a conversation
            starts and the empty-state hero disappears. */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Wand2 size={16} style={{ color: 'var(--accent)' }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Coach</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>tuning {agentName}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {view.mode === 'current' && messages.length > 0 && (
              <button onClick={startNewConversation} title="New conversation (archives this one)" style={iconBtn}>
                <RotateCcw size={14} />
              </button>
            )}
            <button
              onClick={view.mode === 'current' ? openHistory : () => setView({ mode: 'current' })}
              title={view.mode === 'current' ? 'Show past conversations' : 'Back to current'}
              style={{
                ...iconBtn,
                background: view.mode !== 'current' ? 'var(--surface-3)' : 'transparent',
              }}
            >
              <History size={14} />
            </button>
            <button onClick={onClose} title="Close" style={iconBtn}><X size={15} /></button>
          </div>
        </div>

        {/* Messages */}
        {/* minHeight: 0 is load-bearing — without it, flex-items default to
            min-height: auto and refuse to shrink below their content, pushing
            the composer below the viewport on long conversations. */}
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px' }}>
          {view.mode === 'list' && (
            <HistoryList
              archive={archive}
              loaded={archiveLoaded}
              onOpen={id => setView({ mode: 'archive', archiveId: id })}
              onBack={() => setView({ mode: 'current' })}
            />
          )}

          {view.mode === 'archive' && (() => {
            const entry = archive.find(a => a.id === view.archiveId);
            if (!entry) {
              return (
                <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>
                  Archived conversation not found.
                </div>
              );
            }
            return (
              <>
                <button
                  onClick={() => setView({ mode: 'list' })}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'transparent', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '5px 10px', fontSize: 12,
                    color: 'var(--muted)', cursor: 'pointer', marginBottom: 10,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <ArrowLeft size={12} /> Back to history
                </button>
                <div style={{
                  fontSize: 11, color: 'var(--subtle)', marginBottom: 10,
                  padding: '6px 10px', background: 'var(--surface)',
                  border: '1px solid var(--border)', borderRadius: 6,
                }}>
                  Archived {new Date(entry.archivedAt).toLocaleString()} · {entry.messages.length} messages · read-only
                </div>
                {entry.messages.map(m => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    canEdit={false}
                    onApply={() => {}}
                    onReject={() => {}}
                    isStreaming={false}
                    getBefore={() => null}
                  />
                ))}
              </>
            );
          })()}

          {view.mode === 'current' && messages.length === 0 && (
            // Antigravity-inspired empty state: big centered greeting, the
            // composer below is the main input. Suggestions are smart chips
            // tailored to whether the agent is blank or already set up.
            <div style={{
              height: '100%', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 10,
              padding: '24px 8px',
            }}>
              <div style={{
                fontSize: 22, fontWeight: 600, color: 'var(--text)',
                letterSpacing: '-0.01em',
              }}>{agentName}</div>
              <p style={{
                fontSize: 13, color: 'var(--muted)', lineHeight: 1.5,
                margin: 0, textAlign: 'center', maxWidth: 360,
              }}>
                {hasClaudeMd || skillCount > 0
                  ? `I can review ${agentName}'s setup, propose changes, or diagnose failed conversations. Nothing is applied until you click Apply.`
                  : `Describe what ${agentName} should do. I'll draft a system prompt and suggest skills. Nothing is applied until you click Apply.`}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginTop: 14 }}>
                {computeSuggestions({ hasClaudeMd, skillCount, memoryCount, agentName }).map((q, i) => (
                  <button
                    key={i}
                    onClick={() => setInput(q)}
                    style={{
                      textAlign: 'left',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 8, padding: '10px 12px',
                      fontSize: 13, color: 'var(--text)', cursor: 'pointer',
                      fontFamily: 'var(--font-sans)', lineHeight: 1.45,
                      transition: 'background 0.12s, border-color 0.12s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; }}
                  >{q}</button>
                ))}
              </div>
            </div>
          )}

          {view.mode === 'current' && messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              canEdit={canEdit}
              onApply={p => applyProposal(i, p)}
              onReject={p => rejectProposal(i, p)}
              isStreaming={sending && i === messages.length - 1 && m.role === 'assistant'}
              getBefore={p => findProposalBefore(p, currentClaudeMd, currentSkills, currentMemories)}
            />
          ))}

          {view.mode === 'current' && error && (
            <div style={{
              background: 'var(--red-soft-bg)', border: '1px solid var(--red-soft-border)',
              color: 'var(--red)', borderRadius: 6, padding: '8px 12px', fontSize: 13, marginTop: 8,
            }}>{error}</div>
          )}
        </div>

        {/* Composer — flexShrink: 0 so it's always pinned to the bottom and
            never collapses under content pressure from the messages flex child. */}
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px', flexShrink: 0, background: 'var(--surface-2)' }}>
          {/* Antigravity-style unified composer: textarea on top, action row
              inside the same bordered container. Whole thing reads as a single
              input affordance, not three glued-together widgets. */}
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '8px 10px 6px',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                // Enter sends; Shift+Enter inserts a newline. Standard chat
                // convention — the user explicitly asked for this over ⌘↵.
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  if (!composerDisabled) send(input);
                }
              }}
              placeholder={
                !canEdit ? 'Read-only — you lack edit access'
                : bootstrapDrafting ? 'Claude is drafting your initial setup…'
                : 'Ask anything about this agent…'
              }
              disabled={composerDisabled}
              rows={2}
              style={{
                width: '100%', resize: 'none', maxHeight: 200, minHeight: 44,
                background: 'transparent', border: 'none',
                padding: '4px 2px', fontSize: 14,
                lineHeight: 1.5,
                fontFamily: 'var(--font-sans)', color: 'var(--text)', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--subtle)', fontFamily: 'var(--font-sans)' }}>
                ↵ send · ⇧↵ newline
              </span>
              <button
                onClick={() => send(input)}
                disabled={composerDisabled || !input.trim()}
                style={{
                  padding: '6px 12px', borderRadius: 6, border: 'none',
                  background: !composerDisabled && input.trim() ? 'var(--accent)' : 'var(--surface-3)',
                  color: !composerDisabled && input.trim() ? 'var(--accent-fg)' : 'var(--muted)',
                  cursor: !composerDisabled && input.trim() ? 'pointer' : 'not-allowed',
                  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 500,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {(sending || bootstrapDrafting) ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />}
              </button>
            </div>
          </div>
          <div style={{
            fontSize: 10.5, color: 'var(--subtle)', textAlign: 'center',
            marginTop: 6, fontFamily: 'var(--font-sans)',
          }}>
            Coach may make mistakes — review proposals before applying.
          </div>
        </div>
      </aside>

      <style>{`
        @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes coachDot {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30%           { opacity: 1;   transform: translateY(-2px); }
        }
      `}</style>
    </>
  );
}

const iconBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
  padding: 6, cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex',
  alignItems: 'center', justifyContent: 'center',
};

function MessageBubble({
  message, canEdit, onApply, onReject, isStreaming, getBefore,
}: {
  message: CoachMessage;
  canEdit: boolean;
  onApply: (p: CoachProposal) => void;
  onReject: (p: CoachProposal) => void;
  isStreaming: boolean;
  /** Resolve the pre-change content for a proposal (for UPDATE/DELETE diffs). */
  getBefore: (p: CoachProposal) => string | null;
}) {
  const isUser = message.role === 'user';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: '88%', background: isUser ? 'var(--accent)' : 'var(--surface-2)',
        color: isUser ? 'var(--accent-fg)' : 'var(--text)',
        border: isUser ? 'none' : '1px solid var(--border)',
        borderRadius: 10, padding: '9px 13px', fontSize: 13.5, lineHeight: 1.55,
        // User bubbles stay literal text (pre-wrap respects their newlines).
        // Assistant bubbles render markdown — the wrapper doesn't need pre-wrap
        // because ReactMarkdown produces its own block-level <p>/<ul>/<pre>.
        whiteSpace: isUser ? 'pre-wrap' : 'normal',
        wordBreak: 'break-word',
      }}>
        {message.text
          ? (isUser
              ? message.text
              : <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>)
          : (isLiveDraft(message) || isStreaming)
            ? <DraftingIndicator />
            : ''}
      </div>

      {/* Tool-call chips */}
      {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {message.toolCalls.map((t, i) => (
            <span key={i} title={JSON.stringify(t.input)} style={{
              fontSize: 11.5, fontFamily: 'var(--font-mono)', color: t.ok ? 'var(--muted)' : 'var(--red)',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '2px 6px',
            }}>
              {t.name.replace(/^mcp__coach__/, '')}
            </span>
          ))}
        </div>
      )}

      {/* Proposal cards */}
      {!isUser && message.proposals && message.proposals.length > 0 && (
        <div style={{ marginTop: 8, width: '100%' }}>
          {message.proposals.map(p => (
            <ProposalCard
              key={p.id}
              proposal={p}
              canEdit={canEdit}
              onApply={() => onApply(p)}
              onReject={() => onReject(p)}
              before={getBefore(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Trigger a client-side blob download for a wiki extract. The user is expected
 * to drop the downloaded file into their agent's `knowledge/wiki/` directory.
 */
function downloadWikiExtract(extract: { suggestedPath: string; content: string }): void {
  const blob = new Blob([extract.content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = extract.suggestedPath.split('/').pop() || 'wiki-extract.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ProposalCard({
  proposal, canEdit, onApply, onReject, before,
}: {
  proposal: CoachProposal;
  canEdit: boolean;
  onApply: () => void;
  onReject: () => void;
  /** Pre-change content for UPDATE diffs. null when there's no prior state
   *  (e.g. a CREATE proposal or an UPDATE where we can't find the target). */
  before: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const applied = proposal.status === 'applied';
  const rejected = proposal.status === 'rejected';

  const isWikiOnly = proposal.kind === 'wiki-extract';
  const wikiExtract = proposal.kind === 'wiki-extract'
    ? proposal.wikiExtract
    : proposal.wikiExtract;

  const label = proposal.kind === 'claude-md'
    ? 'System Prompt (CLAUDE.md)'
    : proposal.kind === 'memory'
      ? `Memory: ${proposal.memoryName}${proposal.memoryType ? ` (${proposal.memoryType})` : ''}`
      : proposal.kind === 'skill'
        ? `Skill: ${proposal.category}/${proposal.filename}`
        : `Wiki: ${proposal.wikiExtract.suggestedPath}`;

  const actionLabel = proposal.kind === 'claude-md'
    ? 'UPDATE'
    : proposal.kind === 'wiki-extract'
      ? 'SAVE'
      : proposal.action.toUpperCase();

  // Destructive = deletes (skill or memory). Everything else is additive/editing.
  const isDestructive = (proposal.kind === 'skill' && proposal.action === 'delete')
    || (proposal.kind === 'memory' && proposal.action === 'delete');
  const hasExpandableContent =
    proposal.kind === 'claude-md'
    || (proposal.kind === 'skill' && proposal.action !== 'delete' && !!proposal.content)
    || (proposal.kind === 'memory' && proposal.action !== 'delete' && !!proposal.content)
    || (!!wikiExtract); // wiki extract body is always worth showing

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8,
      background: 'var(--surface)',
      padding: 10, marginBottom: 8,
      opacity: rejected ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        {isWikiOnly
          ? <BookOpen size={13} style={{ color: 'var(--muted)' }} />
          : <FileText size={13} style={{ color: 'var(--muted)' }} />}
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
          background: isDestructive
            ? 'var(--red-soft-bg)'
            : isWikiOnly ? 'rgba(99,102,241,0.12)' : 'rgba(16,185,129,0.1)',
          color: isDestructive
            ? 'var(--red)'
            : isWikiOnly ? 'var(--accent)' : 'var(--green)',
        }}>{actionLabel}</span>
        <span style={{ fontSize: 12.5, fontWeight: 500, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{label}</span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '2px 0 6px', lineHeight: 1.5 }}>
        {proposal.rationale}
      </p>

      {/* Wiki-extract hint line — shown when the proposal carries an extract
          alongside a store edit. For wiki-only proposals the summary lives in
          the rationale above. */}
      {wikiExtract && !isWikiOnly && (
        <p style={{
          fontSize: 11.5, color: 'var(--muted)', margin: '0 0 6px',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <BookOpen size={11} />
          Wiki page: <code style={{ fontFamily: 'var(--font-mono)' }}>{wikiExtract.suggestedPath}</code>
          {wikiExtract.summary ? ` — ${wikiExtract.summary}` : ''}
        </p>
      )}

      {hasExpandableContent && (
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 3,
            fontFamily: 'var(--font-sans)',
          }}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? 'Hide content' : 'Show content'}
        </button>
      )}

      {expanded && hasExpandableContent && (() => {
        // Wiki-only cards have no "before" — only the extract body matters.
        if (isWikiOnly) {
          return <ContentBlock text={proposal.wikiExtract.content} />;
        }
        const afterText = proposal.kind === 'claude-md'
          ? proposal.content
          : (proposal.content ?? '');
        return (
          <>
            {/* Show a line-diff when we have prior content that actually differs.
                Falls back to a plain block for CREATE proposals or no-op edits. */}
            {before !== null && before !== afterText
              ? <DiffBlock before={before} after={afterText} />
              : (afterText ? <ContentBlock text={afterText} /> : null)}
            {wikiExtract && (
              <div style={{ marginTop: 6 }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--muted)',
                  textTransform: 'uppercase', letterSpacing: 0.4, margin: '4px 0 3px',
                }}>Wiki page to save</div>
                <ContentBlock text={wikiExtract.content} />
              </div>
            )}
          </>
        );
      })()}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {isWikiOnly ? (
          <button
            onClick={() => downloadWikiExtract(proposal.wikiExtract)}
            style={{
              fontSize: 12, fontWeight: 500, padding: '5px 11px', borderRadius: 5,
              background: 'var(--accent)', color: 'var(--accent-fg)',
              border: 'none', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontFamily: 'var(--font-sans)',
            }}
          >
            <Download size={12} /> Download wiki page
          </button>
        ) : applied ? (
          <span style={{
            fontSize: 12, fontWeight: 500, color: 'var(--green)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}><Check size={13} /> Applied</span>
        ) : rejected ? (
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Rejected</span>
        ) : (
          <>
            <button
              onClick={onApply}
              disabled={!canEdit}
              style={{
                fontSize: 12, fontWeight: 500, padding: '5px 13px', borderRadius: 5,
                background: canEdit ? 'var(--accent)' : 'var(--surface-2)',
                color: canEdit ? 'var(--accent-fg)' : 'var(--muted)',
                border: 'none', cursor: canEdit ? 'pointer' : 'not-allowed',
                fontFamily: 'var(--font-sans)',
              }}
            >Apply</button>
            <button
              onClick={onReject}
              style={{
                fontSize: 12, fontWeight: 500, padding: '5px 11px', borderRadius: 5,
                background: 'transparent', color: 'var(--muted)',
                border: '1px solid var(--border)', cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >Reject</button>
          </>
        )}
        {/* Download button alongside Apply/Reject when the proposal carries an
            extract. Stays active after apply/reject — downloading is always
            safe and doesn't depend on the store edit succeeding. */}
        {!isWikiOnly && wikiExtract && (
          <button
            onClick={() => downloadWikiExtract(wikiExtract)}
            title={`Save ${wikiExtract.suggestedPath}`}
            style={{
              fontSize: 12, fontWeight: 500, padding: '5px 11px', borderRadius: 5,
              background: 'transparent', color: 'var(--muted)',
              border: '1px solid var(--border)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontFamily: 'var(--font-sans)',
              marginLeft: (applied || rejected) ? 0 : 'auto',
            }}
          >
            <Download size={12} /> Download wiki page
          </button>
        )}
      </div>
    </div>
  );
}

/** Three-dot thinking indicator (iMessage/Slack style). Keyframes for the
 *  dot animation live in the <style> block at the bottom of the panel. */
function DraftingIndicator() {
  const dot: React.CSSProperties = {
    width: 6, height: 6, borderRadius: '50%',
    background: 'var(--muted)',
    animation: 'coachDot 1.2s infinite ease-in-out',
  };
  return (
    <span
      aria-label="Thinking"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 0' }}
    >
      <span style={{ ...dot, animationDelay: '0s' }} />
      <span style={{ ...dot, animationDelay: '0.2s' }} />
      <span style={{ ...dot, animationDelay: '0.4s' }} />
    </span>
  );
}

/** Archived-conversations list view. Shows one row per archived thread with
 *  a short excerpt of the first user message, date, and message count. */
function HistoryList({
  archive, loaded, onOpen, onBack,
}: {
  archive: ArchivedConversation[];
  loaded: boolean;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <div>
      <button
        onClick={onBack}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: '1px solid var(--border)',
          borderRadius: 6, padding: '5px 10px', fontSize: 12,
          color: 'var(--muted)', cursor: 'pointer', marginBottom: 10,
          fontFamily: 'var(--font-sans)',
        }}
      >
        <ArrowLeft size={12} /> Back to current
      </button>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
        Past conversations
      </div>
      {!loaded ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 2px' }}>Loading…</div>
      ) : archive.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 2px', lineHeight: 1.5 }}>
          No past conversations yet. Click <RotateCcw size={11} style={{ verticalAlign: 'middle' }} /> to archive the current one and start fresh — archived threads show up here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {archive.map(entry => {
            const firstUser = entry.messages.find(m => m.role === 'user');
            const excerpt = (firstUser?.text ?? '(no user message)').replace(/\s+/g, ' ').slice(0, 80);
            return (
              <button
                key={entry.id}
                onClick={() => onOpen(entry.id)}
                style={{
                  textAlign: 'left', background: 'var(--surface)',
                  border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px',
                  cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-3)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; }}
              >
                <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>
                  {excerpt}{excerpt.length >= 80 ? '…' : ''}
                </div>
                <div style={{ fontSize: 11, color: 'var(--subtle)' }}>
                  {new Date(entry.archivedAt).toLocaleString()} · {entry.messages.length} messages
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ContentBlock({ text }: { text: string }) {
  return (
    <pre style={{
      marginTop: 6, background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '8px 10px', fontSize: 12, color: 'var(--text)',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
      fontFamily: 'var(--font-mono)', maxHeight: 260, overflow: 'auto',
    }}>{text}</pre>
  );
}

/**
 * Classic LCS-based line diff. For the sizes we deal with here (CLAUDE.md,
 * individual skill/memory files, typically under a few thousand lines) an
 * O(n·m) table is more than fast enough and produces the cleanest output.
 */
type DiffLine = { type: 'same' | 'add' | 'del'; text: string };
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** Unified red/green diff rendering for UPDATE proposal cards. */
function DiffBlock({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  const added = lines.filter(l => l.type === 'add').length;
  const removed = lines.filter(l => l.type === 'del').length;
  return (
    <div style={{
      marginTop: 6, background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 6, fontSize: 12, lineHeight: 1.5, fontFamily: 'var(--font-mono)',
      maxHeight: 320, overflow: 'auto',
    }}>
      <div style={{
        padding: '4px 10px', borderBottom: '1px solid var(--border)',
        fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-sans)',
        display: 'flex', gap: 10,
      }}>
        <span style={{ color: 'var(--green)' }}>+{added}</span>
        <span style={{ color: 'var(--red)' }}>−{removed}</span>
      </div>
      <div style={{ padding: '6px 0' }}>
        {lines.map((l, i) => {
          const bg = l.type === 'add' ? 'rgba(16,185,129,0.12)'
            : l.type === 'del' ? 'var(--red-soft-bg)'
              : 'transparent';
          const color = l.type === 'add' ? 'var(--green)'
            : l.type === 'del' ? 'var(--red)'
              : 'var(--text)';
          const marker = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
          return (
            <div key={i} style={{
              display: 'flex', background: bg, color,
              padding: '0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              <span style={{ width: 14, flexShrink: 0, userSelect: 'none', opacity: 0.7 }}>{marker}</span>
              <span style={{ flex: 1 }}>{l.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Look up the pre-change content for a proposal so UPDATE cards can render
 * a real diff. Returns null when there's nothing to diff against (CREATE,
 * or the target skill/memory is missing from the local cache).
 */
function findProposalBefore(
  p: CoachProposal,
  claudeMd: string,
  skills: Skill[],
  memories: Memory[],
): string | null {
  if (p.kind === 'claude-md') return claudeMd;
  if (p.kind === 'skill') {
    if (p.action === 'create') return null;
    const hit = skills.find(s => s.category === p.category && s.filename === p.filename);
    return hit ? hit.content : null;
  }
  if (p.kind === 'memory') {
    if (p.action === 'create') return null;
    const hit = memories.find(m => m.id === p.memoryId);
    return hit ? hit.content : null;
  }
  return null;
}
