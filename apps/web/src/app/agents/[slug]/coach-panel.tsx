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
import { X, Send, Loader2, Paperclip, RotateCcw, Wand2, ChevronDown, ChevronRight, Check, FileText } from 'lucide-react';
import type { CoachMessage, CoachProposal } from '@slackhive/shared';

/** Browser uuid that doesn't require a secure context (HTTP dev, etc). */
const uid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** After this age a still-`inProgress` assistant message is treated as stale
 *  (runner probably crashed mid-turn). Keeps users from being stuck on a
 *  permanent "Drafting…" indicator. */
const STALE_DRAFT_MS = 3 * 60 * 1000;

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

const QUICK_STARTS = [
  'Help me build this agent from scratch — I want it to…',
  'Review my current setup and suggest improvements',
  "Here's a conversation where it went wrong:",
];

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
  const [attachment, setAttachment] = useState('');
  const [showAttach, setShowAttach] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // Auto-scroll on new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const send = async (text: string, attach?: string) => {
    if (!text.trim() || sending) return;
    setError('');
    setSending(true);

    const userMsg: CoachMessage = {
      id: uid(),
      role: 'user',
      text: attach ? `${text}\n\n[attached: failed conversation]` : text,
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
    setAttachment('');
    setShowAttach(false);

    try {
      const res = await fetch(`/api/agents/${agentId}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: text, attachment: attach }),
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
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const reset = async () => {
    if (!confirm('Reset the coach conversation for this agent?')) return;
    await fetch(`/api/agents/${agentId}/coach`, { method: 'DELETE' });
    setMessages([]);
    setError('');
  };

  const applyProposal = async (messageIndex: number, proposal: CoachProposal) => {
    if (!canEdit) return;
    let res: Response;
    if (proposal.kind === 'claude-md') {
      res = await fetch(`/api/agents/${agentId}/claude-md`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: proposal.content,
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
  };

  const rejectProposal = async (messageIndex: number, proposal: CoachProposal) => {
    await fetch(`/api/agents/${agentId}/coach`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: proposal.id, status: 'rejected' }),
    });
    setMessages(prev => patchProposal(prev, messageIndex, proposal.id, 'rejected'));
  };

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', zIndex: 49,
          animation: 'fadeIn 0.15s ease-out',
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Coach — tuning ${agentName}`}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 460, zIndex: 50,
          background: 'var(--surface)', borderLeft: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.08)',
          animation: 'slideInRight 0.18s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Wand2 size={16} style={{ color: 'var(--accent)' }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Coach</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>tuning {agentName}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {messages.length > 0 && (
              <button onClick={reset} title="Reset conversation" style={iconBtn}>
                <RotateCcw size={14} />
              </button>
            )}
            <button onClick={onClose} title="Close" style={iconBtn}><X size={15} /></button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '12px 14px' }}>
          {messages.length === 0 && (
            <div style={{ marginTop: 24 }}>
              <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 14px' }}>
                Talk through what this agent should do. I can inspect its current setup,
                propose changes to the system prompt or skills, and diagnose failed
                conversations you paste. You stay in control — nothing is applied until
                you click Apply.
              </p>
              {QUICK_STARTS.map((q, i) => (
                <button
                  key={i}
                  onClick={() => setInput(q)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '9px 12px', marginBottom: 6,
                    fontSize: 12, color: 'var(--text)', cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                  }}
                >{q}</button>
              ))}
            </div>
          )}

          {messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              canEdit={canEdit}
              onApply={p => applyProposal(i, p)}
              onReject={p => rejectProposal(i, p)}
              isStreaming={sending && i === messages.length - 1 && m.role === 'assistant'}
            />
          ))}

          {error && (
            <div style={{
              background: 'var(--red-soft-bg)', border: '1px solid var(--red-soft-border)',
              color: 'var(--red)', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginTop: 8,
            }}>{error}</div>
          )}
        </div>

        {/* Composer */}
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px' }}>
          {showAttach && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                Paste a failed conversation — Claude will use it to diagnose.
              </div>
              <textarea
                value={attachment}
                onChange={e => setAttachment(e.target.value)}
                placeholder="Paste Slack thread, transcript, or error here…"
                style={{
                  width: '100%', minHeight: 70, maxHeight: 160, boxSizing: 'border-box',
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '8px 10px', fontSize: 11.5,
                  fontFamily: 'var(--font-mono)', color: 'var(--text)', resize: 'vertical',
                }}
              />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!composerDisabled) send(input, showAttach ? attachment : undefined);
                }
              }}
              placeholder={
                !canEdit ? 'Read-only — you lack edit access'
                : bootstrapDrafting ? 'Claude is drafting your initial setup…'
                : 'Describe what this agent should do…'
              }
              disabled={composerDisabled}
              rows={1}
              style={{
                flex: 1, resize: 'none', maxHeight: 140, minHeight: 36,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '8px 10px', fontSize: 12.5,
                fontFamily: 'var(--font-sans)', color: 'var(--text)', outline: 'none',
              }}
            />
            <button
              title="Attach failed conversation"
              onClick={() => setShowAttach(v => !v)}
              disabled={composerDisabled}
              style={{ ...iconBtn, background: showAttach ? 'var(--accent-soft-bg, var(--surface-2))' : 'transparent' }}
            ><Paperclip size={15} /></button>
            <button
              onClick={() => send(input, showAttach ? attachment : undefined)}
              disabled={composerDisabled || !input.trim()}
              style={{
                padding: '8px 12px', borderRadius: 8, border: 'none',
                background: !composerDisabled && input.trim() ? 'var(--accent)' : 'var(--surface-2)',
                color: !composerDisabled && input.trim() ? 'var(--accent-fg)' : 'var(--muted)',
                cursor: !composerDisabled && input.trim() ? 'pointer' : 'not-allowed',
                display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 500,
                fontFamily: 'var(--font-sans)',
              }}
            >
              {(sending || bootstrapDrafting) ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />}
            </button>
          </div>
        </div>
      </aside>

      <style>{`
        @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
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
  message, canEdit, onApply, onReject, isStreaming,
}: {
  message: CoachMessage;
  canEdit: boolean;
  onApply: (p: CoachProposal) => void;
  onReject: (p: CoachProposal) => void;
  isStreaming: boolean;
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
        borderRadius: 10, padding: '8px 12px', fontSize: 12.5, lineHeight: 1.55,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {message.text
          ? message.text
          : (isLiveDraft(message) || isStreaming)
            ? <DraftingIndicator />
            : ''}
      </div>

      {/* Tool-call chips */}
      {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {message.toolCalls.map((t, i) => (
            <span key={i} title={JSON.stringify(t.input)} style={{
              fontSize: 10.5, fontFamily: 'var(--font-mono)', color: t.ok ? 'var(--muted)' : 'var(--red)',
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  proposal, canEdit, onApply, onReject,
}: {
  proposal: CoachProposal;
  canEdit: boolean;
  onApply: () => void;
  onReject: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const applied = proposal.status === 'applied';
  const rejected = proposal.status === 'rejected';

  const label = proposal.kind === 'claude-md'
    ? 'System Prompt (CLAUDE.md)'
    : `Skill: ${proposal.category}/${proposal.filename}`;

  const actionLabel = proposal.kind === 'claude-md'
    ? 'UPDATE'
    : proposal.action.toUpperCase();

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8,
      background: 'var(--surface)',
      padding: 10, marginBottom: 8,
      opacity: rejected ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <FileText size={12} style={{ color: 'var(--muted)' }} />
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
          background: proposal.kind === 'claude-md' || (proposal.kind === 'skill' && proposal.action !== 'delete')
            ? 'rgba(16,185,129,0.1)' : 'var(--red-soft-bg)',
          color: proposal.kind === 'claude-md' || (proposal.kind === 'skill' && proposal.action !== 'delete')
            ? 'var(--green)' : 'var(--red)',
        }}>{actionLabel}</span>
        <span style={{ fontSize: 11.5, fontWeight: 500, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{label}</span>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 6px', lineHeight: 1.5 }}>
        {proposal.rationale}
      </p>

      {(proposal.kind === 'claude-md' || (proposal.kind === 'skill' && proposal.action !== 'delete')) && (
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 3,
            fontFamily: 'var(--font-sans)',
          }}
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {expanded ? 'Hide content' : 'Show content'}
        </button>
      )}

      {expanded && (proposal.kind === 'claude-md'
        ? <ContentBlock text={proposal.content} />
        : proposal.action !== 'delete' && proposal.content ? <ContentBlock text={proposal.content} /> : null)}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {applied ? (
          <span style={{
            fontSize: 11, fontWeight: 500, color: 'var(--green)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}><Check size={12} /> Applied</span>
        ) : rejected ? (
          <span style={{ fontSize: 11, color: 'var(--subtle)' }}>Rejected</span>
        ) : (
          <>
            <button
              onClick={onApply}
              disabled={!canEdit}
              style={{
                fontSize: 11, fontWeight: 500, padding: '4px 12px', borderRadius: 5,
                background: canEdit ? 'var(--accent)' : 'var(--surface-2)',
                color: canEdit ? 'var(--accent-fg)' : 'var(--muted)',
                border: 'none', cursor: canEdit ? 'pointer' : 'not-allowed',
                fontFamily: 'var(--font-sans)',
              }}
            >Apply</button>
            <button
              onClick={onReject}
              style={{
                fontSize: 11, fontWeight: 500, padding: '4px 10px', borderRadius: 5,
                background: 'transparent', color: 'var(--muted)',
                border: '1px solid var(--border)', cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >Reject</button>
          </>
        )}
      </div>
    </div>
  );
}

function DraftingIndicator() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 12 }}>
      <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
      Drafting…
    </span>
  );
}

function ContentBlock({ text }: { text: string }) {
  return (
    <pre style={{
      marginTop: 6, background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '8px 10px', fontSize: 11, color: 'var(--text)',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
      fontFamily: 'var(--font-mono)', maxHeight: 260, overflow: 'auto',
    }}>{text}</pre>
  );
}
