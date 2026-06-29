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
import { createPortal } from 'react-dom';
import { X, Send, Loader2, RotateCcw, Wand2, ChevronDown, ChevronRight, Check, FileText, History, ArrowLeft, BookOpen, Paperclip, Download } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CoachMessage, CoachProposal, Skill, Memory, KnowledgeSource, CheckConfig } from '@slackhive/shared';
import { cn } from '@/lib/utils';

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
  p: ({ children }) => <p className="mb-1.5 leading-[1.55]">{children}</p>,
  ul: ({ children }) => <ul className="mb-1.5 pl-[18px] leading-[1.55]">{children}</ul>,
  ol: ({ children }) => <ol className="mb-1.5 pl-[18px] leading-[1.55]">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="my-1 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-1 text-sm font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-1 text-sm font-semibold">{children}</h3>,
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return (
        <code className={cn(className, 'font-mono text-xs')} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded-[3px] border border-border bg-surface px-[5px] py-px font-mono text-xs"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    const extractText = (node: React.ReactNode): string => {
      if (typeof node === 'string') return node;
      if (Array.isArray(node)) return node.map(extractText).join('');
      if (node && typeof node === 'object' && 'props' in (node as any)) return extractText((node as any).props?.children);
      return '';
    };
    const getLang = (node: React.ReactNode): string => {
      if (node && typeof node === 'object' && 'props' in (node as any))
        return ((node as any).props?.className ?? '').replace('language-', '');
      return '';
    };
    const text = extractText(children);
    const lang = getLang(children);
    // Only show Download for wiki content — markdown/plain large blocks, not code snippets
    const isWikiContent = (lang === 'markdown' || lang === 'md' || lang === '') && text.length > 300;
    const download = () => {
      const blob = new Blob([text], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'wiki-content.md'; a.click();
      URL.revokeObjectURL(url);
    };
    return (
      <div className="relative my-1">
        <pre className="m-0 overflow-auto whitespace-pre rounded-md border border-border bg-surface p-2.5 text-xs leading-normal">
          {children}
        </pre>
        {isWikiContent && (
          <button onClick={download} title="Download as .md file" className="absolute right-1.5 top-1.5 inline-flex cursor-pointer items-center gap-1 rounded-[5px] border border-border bg-surface-2 px-2 py-[3px] font-sans text-2xs text-muted-foreground">
            <Download size={11} /> Download
          </button>
        )}
      </div>
    );
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="w-full border-collapse text-xs leading-normal">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-border px-2 py-1.5 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border px-2 py-1.5 align-top">{children}</td>
  ),
};

export function CoachPanel({
  agentId,
  agentName,
  open,
  onClose,
  canEdit,
  seed,
}: {
  agentId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
  canEdit: boolean;
  /**
   * External trigger to auto-send a message when the panel opens (e.g. the
   * "Ask Coach" button on a failing eval row). `token` must change for each
   * distinct send — Coach watches the token, not the message, so identical
   * seeds from two different rows still fire.
   */
  seed?: { token: string; message: string } | null;
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
  const [currentFileSources, setCurrentFileSources] = useState<KnowledgeSource[]>([]);
  // History view state. `view: 'list'` shows archived conversations;
  // `view: 'archive'` shows one archived thread read-only; `view: 'current'`
  // is the default (live conversation).
  type View = { mode: 'current' } | { mode: 'list' } | { mode: 'archive'; archiveId: string };
  const [view, setView] = useState<View>({ mode: 'current' });
  const [archive, setArchive] = useState<ArchivedConversation[]>([]);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Controller for the in-flight SSE fetch. Used to abort cleanly when the
  // user clicks "New conversation" mid-stream (otherwise the reader hangs
  // until the server closes, `sending` stays true, and the composer is
  // permanently locked — see bug report).
  const abortRef = useRef<AbortController | null>(null);
  // Flips true after the first loadSession tick completes for this open cycle.
  // Gates the seed-message effect so optimistic state from send() isn't
  // overwritten by the session-snapshot setMessages(next) that the GET fires.
  const [sessionLoaded, setSessionLoaded] = useState(false);

  // Fetch agent context once per panel open for smart suggestions.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [mdRes, skRes, memRes, ksRes] = await Promise.all([
          fetch(`/api/agents/${agentId}/claude-md`),
          fetch(`/api/agents/${agentId}/skills`),
          fetch(`/api/agents/${agentId}/memories`),
          fetch(`/api/agents/${agentId}/knowledge`),
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
        if (ksRes.ok) {
          const ks = await ksRes.json();
          const arr: KnowledgeSource[] = Array.isArray(ks) ? ks : [];
          // Coach only manages file-type sources. Filter here so `before`
          // lookups and proposal rendering never pull from a url/repo row.
          setCurrentFileSources(arr.filter(s => s.type === 'file'));
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
    if (!open) {
      // Reset on close so the next open cycle re-gates the seed effect.
      setSessionLoaded(false);
      return;
    }
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
        setSessionLoaded(true);
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

  // Always scroll to bottom when a new message turn starts (sending flips true).
  // During streaming, only follow if already near the bottom.
  const prevSending = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const justStarted = sending && !prevSending.current;
    prevSending.current = sending;
    if (justStarted) {
      el.scrollTo({ top: el.scrollHeight });
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight });
  }, [messages, sending]);

  const send = async (text: string) => {
    if (!text.trim() || sending) return;
    setError('');
    setSending(true);

    const fileForMsg = attachedFile;
    const userMsg: CoachMessage = {
      id: uid(),
      role: 'user',
      text,
      attachmentName: fileForMsg?.name,
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
    setAttachedFile(null);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let body: BodyInit;
      const headers: Record<string, string> = {};
      if (fileForMsg) {
        const form = new FormData();
        form.append('userMessage', text);
        form.append('file', fileForMsg);
        body = form;
        // Let browser set Content-Type with boundary automatically
      } else {
        body = JSON.stringify({ userMessage: text });
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(`/api/agents/${agentId}/coach`, {
        method: 'POST',
        headers,
        body,
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

  /**
   * Auto-fire a seeded message (from "Ask Coach" on a failing eval row) once
   * per token. The ref-based dedup means closing and re-opening the panel with
   * the same seed doesn't re-ask the same question — the page bumps the token
   * for each distinct Ask-Coach click.
   *
   * `sessionLoaded` gate: the loadSession effect above does setMessages(next)
   * after its GET resolves; firing send() before that would race — the GET's
   * setMessages would overwrite our optimistic [userMsg, draft], and incoming
   * SSE deltas would either be dropped (empty tail) or append to a stale
   * assistant message (prior conversation). Wait for the first tick to settle.
   */
  const lastSeedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !seed) return;
    if (!sessionLoaded) return;
    if (seed.token === lastSeedTokenRef.current) return;
    if (sending) return;
    lastSeedTokenRef.current = seed.token;
    void send(seed.message);
    // send is intentionally excluded — it's recreated every render and
    // including it would re-fire on every keystroke in the composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed, sending, sessionLoaded]);

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
    let res: Response;
    if (proposal.kind === 'claude-md') {
      res = await fetch(`/api/agents/${agentId}/claude-md`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: proposal.content,
      });
    } else if (proposal.kind === 'file-source') {
      // Sources now live in wiki_folders — look up which folder owns this source.
      if (!proposal.sourceId) { setError('file-source proposal missing sourceId'); return; }
      const srcMeta = await fetch(`/api/wiki-sources/${proposal.sourceId}`).then(r => r.json()).catch(() => null);
      if (!srcMeta?.folderId) { setError('Could not locate source folder — it may have been deleted.'); return; }
      const folderId = srcMeta.folderId;
      if (proposal.action === 'delete') {
        res = await fetch(`/api/wiki-folders/${folderId}/sources/${proposal.sourceId}`, { method: 'DELETE' });
      } else {
        res = await fetch(`/api/wiki-folders/${folderId}/sources/${proposal.sourceId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: proposal.name, content: proposal.content ?? '' }),
        });
      }
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
    } else if (proposal.kind === 'eval-case-check') {
      res = await fetch(`/api/agents/${agentId}/evals/cases/${proposal.caseId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checks: proposal.after }),
      });
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
    if (proposal.kind === 'eval-case-check') {
      window.dispatchEvent(new Event('slackhive:evals-refresh'));
    }
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

  // Portal to document.body so the panel escapes any transformed ancestor
  // (e.g. the AgentPage wrapper carries `.fade-up`, which leaves a persistent
  // `transform: translateY(0)` via `animation-fill-mode: both` — that creates
  // a new containing block and would otherwise pin `position: fixed; top: 0`
  // to the scrolled-past page top instead of the viewport.
  return createPortal((
    <>
      <div
        onClick={onClose}
        // Stronger backdrop for proper separation — light mode gets a soft
        // darken, dark mode gets noticeably more dim so the elevated panel
        // reads as a distinct surface against the page behind.
        className="fixed inset-0 z-[49] bg-black/45 backdrop-blur-[2px]"
        style={{ animation: 'fadeIn 0.15s ease-out' }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Coach — tuning ${agentName}`}
        // Explicit height: 100vh + top: 0 belt-and-suspenders — some browsers
        // don't resolve `top: 0 + bottom: 0` during the slide-in animation,
        // causing the composer to land below the viewport.
        // `--surface-2` is one step elevated from the page background — the
        // panel reads as a distinct card in both light and dark themes. The
        // strong left border + shadow seal the boundary.
        className="fixed right-0 top-0 z-50 flex h-screen w-[520px] max-w-[100vw] flex-col border-l border-border bg-surface-2 shadow-modal"
        style={{ animation: 'slideInRight 0.18s ease-out' }}
      >
        {/* Header — wand icon + stacked label on the left ("Coach" over
            "tuning {agentName}"); icon buttons on the right. The subtitle
            stays because the agent name is easily lost once a conversation
            starts and the empty-state hero disappears. */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Wand2 size={16} className="text-brand" />
            <div>
              <div className="text-sm font-semibold text-foreground">Coach</div>
              <div className="text-2xs text-muted-foreground">tuning {agentName}</div>
            </div>
          </div>
          <div className="flex gap-1">
            {view.mode === 'current' && messages.length > 0 && (
              <button onClick={startNewConversation} title="New conversation (archives this one)" className={iconBtn}>
                <RotateCcw size={14} />
              </button>
            )}
            <button
              onClick={view.mode === 'current' ? openHistory : () => setView({ mode: 'current' })}
              title={view.mode === 'current' ? 'Show past conversations' : 'Back to current'}
              className={cn(iconBtn, view.mode !== 'current' ? 'bg-surface-3' : 'bg-transparent')}
            >
              <History size={14} />
            </button>
            <button onClick={onClose} title="Close" className={iconBtn}><X size={15} /></button>
          </div>
        </div>

        {/* Messages */}
        {/* minHeight: 0 is load-bearing — without it, flex-items default to
            min-height: auto and refuse to shrink below their content, pushing
            the composer below the viewport on long conversations. */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
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
                <div className="p-4 text-sm text-muted-foreground">
                  Archived conversation not found.
                </div>
              );
            }
            return (
              <>
                <button
                  onClick={() => setView({ mode: 'list' })}
                  className="mb-2.5 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 py-[5px] font-sans text-xs text-muted-foreground"
                >
                  <ArrowLeft size={12} /> Back to history
                </button>
                <div className="mb-2.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-2xs text-subtle">
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
            <div className="flex h-full flex-col items-center justify-center gap-2.5 px-2 py-6">
              <div className="text-xl font-semibold tracking-[-0.01em] text-foreground">{agentName}</div>
              <p className="m-0 max-w-[360px] text-center text-sm leading-normal text-muted-foreground">
                {hasClaudeMd || skillCount > 0
                  ? `I can review ${agentName}'s setup, propose changes, or diagnose failed conversations. Nothing is applied until you click Apply.`
                  : `Describe what ${agentName} should do. I'll draft a system prompt and suggest skills. Nothing is applied until you click Apply.`}
              </p>
              <div className="mt-3.5 flex w-full flex-col gap-1.5">
                {computeSuggestions({ hasClaudeMd, skillCount, memoryCount, agentName }).map((q, i) => (
                  <button
                    key={i}
                    onClick={() => setInput(q)}
                    className="cursor-pointer rounded-lg border border-border bg-surface px-3 py-2.5 text-left font-sans text-sm leading-[1.45] text-foreground transition-colors hover:bg-surface-3"
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
              getBefore={p => findProposalBefore(p, currentClaudeMd, currentSkills, currentMemories, currentFileSources)}
            />
          ))}

          {view.mode === 'current' && error && (
            <div
              className="mt-2 rounded-md border px-3 py-2 text-sm text-red"
              style={{ background: 'var(--red-soft-bg)', borderColor: 'var(--red-soft-border)' }}
            >{error}</div>
          )}
        </div>

        {/* Composer — flexShrink: 0 so it's always pinned to the bottom and
            never collapses under content pressure from the messages flex child. */}
        <div className="flex-shrink-0 border-t border-border bg-surface-2 px-3 py-2.5">
          {/* Antigravity-style unified composer: textarea on top, action row
              inside the same bordered container. Whole thing reads as a single
              input affordance, not three glued-together widgets. */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.rst,.log,.pdf"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) setAttachedFile(f); e.target.value = ''; }}
          />
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-2.5 pb-1.5 pt-2">
            {attachedFile && (
              <div className="flex items-center gap-[5px]">
                <span className="inline-flex items-center gap-1 rounded border border-border bg-surface-3 px-[7px] py-0.5 text-2xs text-foreground">
                  <Paperclip size={10} />
                  {attachedFile.name}
                </span>
                <button
                  onClick={() => setAttachedFile(null)}
                  className="cursor-pointer border-none bg-none p-0 leading-none text-muted-foreground"
                  title="Remove attachment"
                >
                  <X size={11} />
                </button>
              </div>
            )}
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
                : sending ? 'Coach is replying…'
                : 'Ask anything about this agent…'
              }
              disabled={composerDisabled}
              rows={2}
              className="max-h-[200px] min-h-[44px] w-full resize-none border-none bg-transparent px-0.5 py-1 font-sans text-base leading-normal text-foreground outline-none"
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={composerDisabled}
                title="Attach a file"
                className={cn(
                  'border-none bg-none px-1 py-0.5 leading-none',
                  composerDisabled ? 'cursor-not-allowed' : 'cursor-pointer',
                  attachedFile ? 'text-brand' : 'text-muted-foreground',
                )}
              >
                <Paperclip size={14} />
              </button>
              <span className="flex-1" />
              {(sending || bootstrapDrafting) ? (
                <span
                  title="Coach is replying"
                  className="inline-flex items-center gap-1.5 font-sans text-2xs font-semibold text-brand"
                >
                  <DraftingIndicator color="var(--accent)" size={5} />
                  Coach is replying
                </span>
              ) : (
                <span className="font-sans text-2xs text-subtle">
                  ↵ send · ⇧↵ newline
                </span>
              )}
              <button
                onClick={() => send(input)}
                disabled={composerDisabled || !input.trim()}
                className={cn(
                  'inline-flex items-center gap-[5px] rounded-md border-none px-3 py-1.5 font-sans text-xs font-medium',
                  !composerDisabled && input.trim()
                    ? 'cursor-pointer bg-brand text-brand-fg'
                    : 'cursor-not-allowed bg-surface-3 text-muted-foreground',
                )}
              >
                {(sending || bootstrapDrafting) ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />}
              </button>
            </div>
          </div>
          <div className="mt-1.5 text-center font-sans text-2xs text-subtle">
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
  ), document.body);
}

const iconBtn = 'inline-flex cursor-pointer items-center justify-center rounded-md border border-border bg-transparent p-1.5 text-muted-foreground';

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
    <div className={cn('mb-3 flex flex-col', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[88%] break-words rounded-lg px-3 py-2 text-sm leading-[1.55]',
          // User bubbles stay literal text (pre-wrap respects their newlines).
          // Assistant bubbles render markdown — the wrapper doesn't need pre-wrap
          // because ReactMarkdown produces its own block-level <p>/<ul>/<pre>.
          isUser
            ? 'whitespace-pre-wrap bg-brand text-brand-fg'
            : 'whitespace-normal border border-border bg-surface-2 text-foreground',
        )}
      >
        {message.text
          ? (isUser
              ? message.text
              : <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>)
          : (isLiveDraft(message) || isStreaming)
            ? <DraftingIndicator />
            : ''}
        {isUser && message.attachmentName && (
          <div className="mt-1.5 inline-flex items-center gap-1 rounded bg-black/15 px-[7px] py-0.5 text-2xs text-brand-fg opacity-85">
            <Paperclip size={10} />
            {message.attachmentName}
          </div>
        )}
      </div>

      {/* Tool-call chips */}
      {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {message.toolCalls.map((t, i) => (
            <span
              key={i}
              title={JSON.stringify(t.input)}
              className={cn(
                'rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-2xs',
                t.ok ? 'text-muted-foreground' : 'text-red',
              )}
            >
              {t.name.replace(/^mcp__coach__/, '')}
            </span>
          ))}
        </div>
      )}

      {/* Proposal cards */}
      {!isUser && message.proposals && message.proposals.length > 0 && (
        <div className="mt-2 w-full">
          {message.proposals.map(p => (
            p.kind === 'eval-case-check' ? (
              <EvalCheckProposalCard
                key={p.id}
                proposal={p}
                canEdit={canEdit}
                onApply={() => onApply(p)}
                onReject={() => onReject(p)}
              />
            ) : (
              <ProposalCard
                key={p.id}
                proposal={p}
                canEdit={canEdit}
                onApply={() => onApply(p)}
                onReject={() => onReject(p)}
                before={getBefore(p)}
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  proposal, canEdit, onApply, onReject, before,
}: {
  /** Eval-check proposals are routed to EvalCheckProposalCard upstream. */
  proposal: Exclude<CoachProposal, { kind: 'eval-case-check' }>;
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

  const label = proposal.kind === 'claude-md'
    ? 'System Prompt (AGENTS.md)'
    : proposal.kind === 'memory'
      ? `Memory: ${proposal.memoryName}${proposal.memoryType ? ` (${proposal.memoryType})` : ''}`
      : proposal.kind === 'skill'
        ? `Skill: ${proposal.category}/${proposal.filename}`
        : `File source: ${proposal.name}`;

  const actionLabel = proposal.kind === 'claude-md'
    ? 'UPDATE'
    : proposal.action.toUpperCase();

  // Destructive = deletes (skill, memory, or file source).
  const isDestructive =
    (proposal.kind === 'skill' && proposal.action === 'delete')
    || (proposal.kind === 'memory' && proposal.action === 'delete')
    || (proposal.kind === 'file-source' && proposal.action === 'delete');

  const hasExpandableContent =
    proposal.kind === 'claude-md'
    || (proposal.kind === 'skill' && proposal.action !== 'delete' && !!proposal.content)
    || (proposal.kind === 'memory' && proposal.action !== 'delete' && !!proposal.content)
    // File-source delete cards still expand — showing what's about to be removed.
    || (proposal.kind === 'file-source' && (proposal.action !== 'delete' ? !!proposal.content : before !== null));

  const isFileSource = proposal.kind === 'file-source';

  return (
    <div className={cn('mb-2 rounded-lg border border-border bg-surface p-2.5', rejected && 'opacity-55')}>
      <div className="mb-1 flex items-center gap-1.5">
        {isFileSource
          ? <BookOpen size={13} className="text-muted-foreground" />
          : <FileText size={13} className="text-muted-foreground" />}
        <span
          className={cn(
            'rounded-[3px] px-1.5 py-px text-2xs font-bold',
            isDestructive ? 'text-red' : isFileSource ? 'bg-brand/10 text-brand' : 'bg-green/10 text-green',
          )}
          style={isDestructive ? { background: 'var(--red-soft-bg)' } : undefined}
        >{actionLabel}</span>
        <span className="font-mono text-xs font-medium text-foreground">{label}</span>
      </div>
      <p className="mb-1.5 mt-0.5 text-xs leading-normal text-muted-foreground">
        {proposal.rationale}
      </p>

      {/* File-source: where this lands, and a reminder that applying the DB
          change does NOT auto-sync the wiki — the user runs that from the
          Knowledge tab where the progress UI lives. */}
      {isFileSource && proposal.action !== 'delete' && (
        <p className="mb-1.5 inline-flex items-center gap-1 text-2xs text-muted-foreground">
          <BookOpen size={11} />
          Stored as <code className="font-mono">knowledge/sources/{proposal.name}.md</code>
          {' — open the Knowledge tab and click Sync to refresh the wiki.'}
        </p>
      )}

      {hasExpandableContent && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="inline-flex cursor-pointer items-center gap-0.5 border-none bg-none p-0 font-sans text-xs text-muted-foreground"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? 'Hide content' : 'Show content'}
        </button>
      )}

      {expanded && hasExpandableContent && (() => {
        const afterText = proposal.kind === 'claude-md'
          ? proposal.content
          : (proposal.content ?? '');
        // File-source delete: no `after` — just show what's about to disappear.
        if (isFileSource && proposal.action === 'delete') {
          return before ? <ContentBlock text={before} /> : null;
        }
        return (
          <>
            {/* Show a line-diff when we have prior content that actually differs.
                Falls back to a plain block for CREATE proposals or no-op edits. */}
            {before !== null && before !== afterText
              ? <DiffBlock before={before} after={afterText} />
              : (afterText ? <ContentBlock text={afterText} /> : null)}
          </>
        );
      })()}

      <div className="mt-2 flex items-center gap-1.5">
        {applied ? (
          <>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green"><Check size={13} /> Applied</span>
            {isFileSource && (
              <>
                <span className="text-xs text-subtle">·</span>
                <span className="text-xs text-muted-foreground">
                  Sync from the Knowledge tab to refresh the wiki.
                </span>
              </>
            )}
          </>
        ) : rejected ? (
          <span className="text-xs text-subtle">Rejected</span>
        ) : (
          <>
            <button
              onClick={onApply}
              disabled={!canEdit}
              className={cn(
                'rounded-[5px] border-none px-3 py-[5px] font-sans text-xs font-medium',
                canEdit ? 'cursor-pointer bg-brand text-brand-fg' : 'cursor-not-allowed bg-surface-2 text-muted-foreground',
              )}
            >Apply</button>
            <button
              onClick={onReject}
              className="cursor-pointer rounded-[5px] border border-border bg-transparent px-2.5 py-[5px] font-sans text-xs font-medium text-muted-foreground"
            >Reject</button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Approval card for an `eval-case-check` proposal — uses the same chip
 * vocabulary as the case editor (no JSON diff). Renders the Before checks in
 * a red-striped block and the After checks in a green-striped block.
 */
function EvalCheckProposalCard({
  proposal, canEdit, onApply, onReject,
}: {
  proposal: Extract<CoachProposal, { kind: 'eval-case-check' }>;
  canEdit: boolean;
  onApply: () => void;
  onReject: () => void;
}) {
  const applied = proposal.status === 'applied';
  const rejected = proposal.status === 'rejected';
  const triageLabel = proposal.triage === 'skill_issue' ? 'Skill issue'
    : proposal.triage === 'test_mismatch' ? 'Test mismatch'
    : 'Real failure';

  return (
    <div className={cn('mb-2 rounded-lg border border-border bg-surface p-2.5', rejected && 'opacity-55')}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <FileText size={13} className="text-muted-foreground" />
        <span className="rounded-[3px] bg-brand/10 px-1.5 py-px text-2xs font-bold text-brand">{triageLabel.toUpperCase()}</span>
        <span className="text-xs font-medium text-foreground">
          Test case checks
        </span>
      </div>
      <div className="mb-1.5 mt-0.5 rounded border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-text-2">
        &ldquo;{proposal.caseQuestion}&rdquo;
      </div>
      <p className="mb-2 mt-0.5 text-xs leading-normal text-muted-foreground">
        {proposal.rationale}
      </p>

      <CheckList label="Before" variant="before" checks={proposal.before} />
      <CheckList label="After"  variant="after"  checks={proposal.after} />

      <div className="mt-2 flex items-center gap-1.5">
        {applied ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green"><Check size={13} /> Applied</span>
        ) : rejected ? (
          <span className="text-xs text-subtle">Rejected</span>
        ) : (
          <>
            <button
              onClick={onApply}
              disabled={!canEdit}
              className={cn(
                'rounded-[5px] border-none px-3 py-[5px] font-sans text-xs font-medium',
                canEdit ? 'cursor-pointer bg-brand text-brand-fg' : 'cursor-not-allowed bg-surface-2 text-muted-foreground',
              )}
            >Apply</button>
            <button
              onClick={onReject}
              className="cursor-pointer rounded-[5px] border border-border bg-transparent px-2.5 py-[5px] font-sans text-xs font-medium text-muted-foreground"
            >Reject</button>
          </>
        )}
      </div>
    </div>
  );
}

function CheckList({ label, variant, checks }: {
  label: string;
  variant: 'before' | 'after';
  checks: CheckConfig[];
}) {
  if (checks.length === 0) {
    return (
      <div className="mt-2">
        <div className={sectionLabelClass}>{label}</div>
        <div className="py-1 text-xs italic text-subtle">
          (no checks)
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className={sectionLabelClass}>{label}</div>
      {checks.map((c, i) => <CheckRow key={i} check={c} variant={variant} />)}
    </div>
  );
}

const sectionLabelClass = 'mb-1 text-2xs font-bold uppercase tracking-[0.04em] text-muted-foreground';

function CheckRow({ check, variant }: { check: CheckConfig; variant: 'before' | 'after' }) {
  // Left stripe + soft background tint per side: red for "before", green for
  // "after". The soft tints have no design-system token, so they stay inline.
  const stripe = variant === 'before' ? 'var(--red)' : 'var(--green)';
  const bg = variant === 'before' ? 'var(--red-soft-bg, rgba(239,68,68,0.06))' : 'rgba(16,185,129,0.06)';
  return (
    <div
      className="mb-1 flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
      style={{ borderLeft: `3px solid ${stripe}`, background: bg }}
    >
      <span className="flex-shrink-0 rounded border border-brand/25 bg-brand/10 px-1.5 py-px font-mono text-2xs font-semibold text-brand">{check.primitive}</span>
      <div className="flex flex-1 flex-wrap items-center gap-[5px] text-xs">
        {renderCheckValue(check)}
      </div>
    </div>
  );
}

function renderCheckValue(check: CheckConfig): React.ReactNode {
  if (check.primitive === 'tool_called') {
    const must = check.must_call ?? [];
    const not = check.must_not_call ?? [];
    return (
      <>
        {must.map((t, i) => (
          <React.Fragment key={`mc-${i}`}>
            {i > 0 && <span className={connectorClass}>or</span>}
            <span className={toolChipClass}>{t}</span>
          </React.Fragment>
        ))}
        {not.map((t, i) => (
          <React.Fragment key={`nc-${i}`}>
            <span className={connectorClass}>not</span>
            <span className={toolChipClass}>{t}</span>
          </React.Fragment>
        ))}
        {must.length === 0 && not.length === 0 && (
          <span className="italic text-subtle">(no tools)</span>
        )}
      </>
    );
  }
  if (check.primitive === 'substring') {
    const must = check.must_contain ?? [];
    const not = check.must_not_contain ?? [];
    return (
      <>
        {must.map((s, i) => (
          <React.Fragment key={`mc-${i}`}>
            {i > 0 && <span className={connectorClass}>and</span>}
            <span className={toolChipClass}>contains &ldquo;{s}&rdquo;</span>
          </React.Fragment>
        ))}
        {not.map((s, i) => (
          <React.Fragment key={`nc-${i}`}>
            <span className={connectorClass}>not</span>
            <span className={toolChipClass}>&ldquo;{s}&rdquo;</span>
          </React.Fragment>
        ))}
      </>
    );
  }
  // llm_judge
  return (
    <span className="italic text-foreground">
      &ldquo;{check.rubric}&rdquo;
    </span>
  );
}

const toolChipClass = 'inline-flex items-center rounded border border-border bg-surface-2 px-[7px] py-0.5 font-mono text-2xs text-foreground';
const connectorClass = 'text-2xs font-bold uppercase tracking-[0.04em] text-subtle';

/** Three-dot thinking indicator (iMessage/Slack style). Keyframes for the
 *  dot animation live in the <style> block at the bottom of the panel. */
function DraftingIndicator({ color = 'var(--muted)', size = 6 }: { color?: string; size?: number } = {}) {
  const dot: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%',
    background: color,
    animation: 'coachDot 1.2s infinite ease-in-out',
  };
  return (
    <span
      aria-label="Thinking"
      className="inline-flex items-center gap-1 py-0.5"
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
        className="mb-2.5 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 py-[5px] font-sans text-xs text-muted-foreground"
      >
        <ArrowLeft size={12} /> Back to current
      </button>
      <div className="mb-2 text-sm font-semibold text-foreground">
        Past conversations
      </div>
      {!loaded ? (
        <div className="px-0.5 py-2 text-sm text-muted-foreground">Loading…</div>
      ) : archive.length === 0 ? (
        <div className="px-0.5 py-2 text-sm leading-normal text-muted-foreground">
          No past conversations yet. Click <RotateCcw size={11} className="align-middle" /> to archive the current one and start fresh — archived threads show up here.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {archive.map(entry => {
            const firstUser = entry.messages.find(m => m.role === 'user');
            const excerpt = (firstUser?.text ?? '(no user message)').replace(/\s+/g, ' ').slice(0, 80);
            return (
              <button
                key={entry.id}
                onClick={() => onOpen(entry.id)}
                className="flex cursor-pointer flex-col gap-0.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-left font-sans transition-colors hover:bg-surface-3"
              >
                <div className="text-xs leading-[1.45] text-foreground">
                  {excerpt}{excerpt.length >= 80 ? '…' : ''}
                </div>
                <div className="text-2xs text-subtle">
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
    <pre className="mt-1.5 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2 px-2.5 py-2 font-mono text-xs leading-normal text-foreground">{text}</pre>
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
    <div className="mt-1.5 max-h-[320px] overflow-auto rounded-md border border-border bg-surface-2 font-mono text-xs leading-normal">
      <div className="flex gap-2.5 border-b border-border px-2.5 py-1 font-sans text-2xs text-muted-foreground">
        <span className="text-green">+{added}</span>
        <span className="text-red">−{removed}</span>
      </div>
      <div className="py-1.5">
        {lines.map((l, i) => {
          // Per-line add/del tint. The green add-tint and red soft-bg have no
          // design-system token, so the background stays inline.
          const bg = l.type === 'add' ? 'rgba(16,185,129,0.12)'
            : l.type === 'del' ? 'var(--red-soft-bg)'
              : 'transparent';
          const colorClass = l.type === 'add' ? 'text-green'
            : l.type === 'del' ? 'text-red'
              : 'text-foreground';
          const marker = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
          return (
            <div
              key={i}
              className={cn('flex whitespace-pre-wrap break-words px-2.5', colorClass)}
              style={{ background: bg }}
            >
              <span className="w-3.5 flex-shrink-0 select-none opacity-70">{marker}</span>
              <span className="flex-1">{l.text || ' '}</span>
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
  fileSources: KnowledgeSource[],
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
  if (p.kind === 'file-source') {
    if (p.action === 'create') return null;
    const hit = fileSources.find(s => s.id === p.sourceId);
    return hit ? (hit.content ?? '') : null;
  }
  return null;
}
