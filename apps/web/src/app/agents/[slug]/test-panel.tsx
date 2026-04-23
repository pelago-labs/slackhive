'use client';

/**
 * @fileoverview Test-mode chat — in-app preview of the agent's real runtime.
 *
 * Replaces the entire agent detail main-window when the user hits Test next
 * to the agent name. The SlackHive left sidebar stays visible (rendered by
 * `layout-shell.tsx`); clicking away via the sidebar naturally unmounts this.
 *
 * When the root agent is a boss, its `<@specialistId>` delegations are
 * simulated by the runner's test orchestrator: each specialist's reply
 * comes through the SSE stream with its own `agent: { id, name }` field,
 * and renders as its own bubble so the delegation chain is readable.
 *
 * Wire: component → POST /api/agents/[id]/test → runner SSE → chat bubbles.
 *
 * @module web/app/agents/[slug]/test-panel
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Send, RotateCcw, Loader2, ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '@/lib/auth-context';

/** Browser uuid that doesn't require a secure context (HTTP dev, etc). */
const uid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface AgentRef { id: string; name: string; botUserId?: string }
interface ToolCall { id: string; name: string; input: unknown }
interface Notice { id: string; text: string }
interface TestMessage {
  id: string;
  role: 'user' | 'agent' | 'error';
  text: string;
  /** Which participant emitted this bubble (agent role only). */
  agent?: AgentRef;
  toolCalls?: ToolCall[];
  /** Inline muted notes under this bubble — e.g. "No agent found for <@Uxxx>". */
  notices?: Notice[];
  /** Streaming state — flipped off when `done` arrives. */
  streaming?: boolean;
}

/** Same markdown styling as coach-panel, tightened for a wider chat column. */
const MD_COMPONENTS: Components = {
  p: ({ children }) => <p style={{ margin: '0 0 8px', lineHeight: 1.6 }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '0 0 8px', paddingLeft: 20, lineHeight: 1.6 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 8px', paddingLeft: 20, lineHeight: 1.6 }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
  h1: ({ children }) => <h1 style={{ fontSize: 16, fontWeight: 600, margin: '8px 0 6px' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: 15, fontWeight: 600, margin: '8px 0 6px' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 600, margin: '6px 0 4px' }}>{children}</h3>,
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
        margin: '6px 0 8px',
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
};

/**
 * Rewrite Slack-style `<@Uxxx>` mentions to `@AgentName` for readability.
 * Unknown mentions are left as `@Uxxx` so the user still sees that *something*
 * was tagged; that's enough to debug a broken delegation.
 */
function renameMentions(text: string, botIdToName: Record<string, string>): string {
  return text.replace(/<@([UW][A-Z0-9]+)>/g, (_, id) => {
    const name = botIdToName[id];
    return name ? `@${name}` : `@${id}`;
  });
}

function ToolChip({ call, agentName }: { call: ToolCall; agentName?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        marginTop: 6,
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--surface)',
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
      }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          width: '100%',
          padding: '6px 8px',
          background: 'transparent',
          border: 'none',
          color: 'var(--muted)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>
          {agentName ? <span style={{ color: 'var(--text)' }}>{agentName}</span> : null}
          {agentName ? ' called ' : 'Called '}
          <span style={{ color: 'var(--text)' }}>{call.name}</span>
        </span>
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: '0 10px 8px 26px',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--muted)',
          }}
        >
          {(() => {
            try { return JSON.stringify(call.input, null, 2); }
            catch { return String(call.input); }
          })()}
        </pre>
      )}
    </div>
  );
}

export function TestPanel({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const { username } = useAuth();
  const [sessionId, setSessionId] = useState<string>(() => uid());
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Map of platformBotUserId → agent display name, built from SSE events as they
  // arrive. Used to rewrite mention tokens in rendered markdown.
  const botIdToName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const msg of messages) {
      if (msg.agent?.botUserId && msg.agent.name) m[msg.agent.botUserId] = msg.agent.name;
    }
    return m;
  }, [messages]);

  // Auto-scroll to bottom on message change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Destroy the runner session on unmount so workDirs don't pile up.
  useEffect(() => {
    return () => {
      const sid = sessionId;
      // fire-and-forget — page is unmounting.
      fetch(`/api/agents/${agentId}/test`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
        keepalive: true,
      }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: TestMessage = { id: uid(), role: 'user', text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/agents/${agentId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text, user: username || null }),
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
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            setMessages(prev => applyEvent(prev, ev));
          } catch { /* skip malformed frame */ }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User canceled — flip any streaming bubbles off.
        setMessages(prev => prev.map(m => m.streaming ? { ...m, streaming: false } : m));
      } else {
        const msg = (err as Error).message;
        setMessages(prev => [...prev, { id: uid(), role: 'error', text: msg }]);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
  };

  /** Reset = destroy runner session + clear chat + new sessionId. */
  const reset = async () => {
    abortRef.current?.abort();
    const sid = sessionId;
    setMessages([]);
    setSessionId(uid());
    await fetch(`/api/agents/${agentId}/test`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    }).catch(() => {});
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg)',
      }}
    >
      {/* Slim header strip — "Testing: <name>" on the left, reset + close on the right. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
            <MessageSquare size={15} style={{ color: 'var(--accent)' }} />
            Testing: {agentName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Tools run live · Memory writes aren&apos;t saved
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={reset}
            disabled={sending}
            title="Reset conversation"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 10px',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              cursor: sending ? 'not-allowed' : 'pointer',
              fontSize: 12,
              opacity: sending ? 0.6 : 1,
            }}
          >
            <RotateCcw size={13} /> Reset
          </button>
          <button
            onClick={onClose}
            title="Close test mode"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30,
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Scrollable chat body. */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '24px 20px',
        }}
      >
        <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {messages.length === 0 && !sending && (
            <div
              style={{
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13,
                lineHeight: 1.6,
                padding: '80px 20px',
              }}
            >
              <div style={{ fontSize: 15, color: 'var(--text)', marginBottom: 8 }}>
                Chat with your agent.
              </div>
              Preview only — nothing posts to connected platforms. Tools run live; memory writes aren&apos;t saved.
            </div>
          )}

          {messages.map((m, i) => {
            // Group consecutive bubbles from the same agent (no repeated header).
            const prev = i > 0 ? messages[i - 1] : null;
            const sameAgentAsPrev =
              m.role === 'agent' && prev?.role === 'agent' && prev.agent?.id === m.agent?.id;
            return (
              <MessageBubble
                key={m.id}
                message={m}
                showAgentHeader={m.role === 'agent' && !sameAgentAsPrev}
                botIdToName={botIdToName}
              />
            );
          })}

          {sending && messages[messages.length - 1]?.role === 'user' && (
            /* Placeholder while waiting for the first SSE text chunk. */
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{ maxWidth: '85%', color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>
                <Loader2 size={12} style={{ display: 'inline', animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
                Thinking…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer. */}
      <div
        style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
          padding: '12px 20px',
          flexShrink: 0,
        }}
      >
        <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Type a message…"
            rows={1}
            disabled={sending}
            style={{
              flex: 1,
              minHeight: 40,
              maxHeight: 180,
              padding: '10px 12px',
              background: 'var(--bg)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 13.5,
              lineHeight: 1.5,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 16px',
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              cursor: (sending || !input.trim()) ? 'not-allowed' : 'pointer',
              opacity: (sending || !input.trim()) ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            {sending ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/** Render one message (user / agent / error). */
function MessageBubble({
  message,
  showAgentHeader,
  botIdToName,
}: {
  message: TestMessage;
  showAgentHeader: boolean;
  botIdToName: Record<string, string>;
}) {
  const m = message;
  if (m.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          className="user-bubble"
          style={{
            maxWidth: '75%',
            padding: '10px 14px',
            background: 'var(--accent)',
            color: 'var(--accent-fg)',
            borderRadius: 12,
            fontSize: 13.5,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {m.text}
        </div>
      </div>
    );
  }

  if (m.role === 'error') {
    const friendly =
      m.text === 'delegation-depth-exceeded'
        ? 'Delegation chain too long — aborting. Check the boss\u2019s CLAUDE.md or the specialist\u2019s reply pattern.'
        : m.text;
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <div
          style={{
            maxWidth: '85%',
            padding: '10px 14px',
            background: 'rgba(220, 38, 38, 0.08)',
            border: '1px solid rgba(220, 38, 38, 0.35)',
            color: 'var(--text)',
            borderRadius: 12,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 600, marginBottom: 4 }}>ERROR</div>
          {friendly}
        </div>
      </div>
    );
  }

  // Agent bubble.
  const rendered = m.text ? renameMentions(m.text, botIdToName) : '';
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{ maxWidth: '85%', width: '100%' }}>
        {showAgentHeader && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              marginBottom: 4,
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
            }}
          >
            {m.agent?.name ?? 'Agent'}
          </div>
        )}
        <div style={{ fontSize: 13.5, color: 'var(--text)' }}>
          {rendered
            ? <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={[remarkGfm]}>{rendered}</ReactMarkdown>
            : m.streaming
              ? <span style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 12 }}>
                  <Loader2 size={12} style={{ display: 'inline', animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
                  Thinking…
                </span>
              : null}
          {m.streaming && rendered && <span style={{ opacity: 0.5 }}>▍</span>}
        </div>
        {m.toolCalls?.map(call => <ToolChip key={call.id} call={call} agentName={m.agent?.name} />)}
        {m.notices?.map(n => (
          <div
            key={n.id}
            style={{
              marginTop: 6,
              fontSize: 12,
              color: 'var(--muted)',
              fontStyle: 'italic',
              lineHeight: 1.5,
            }}
          >
            {renameMentions(n.text, botIdToName)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Pure reducer for SSE events. Each `text` event either appends to the
 * trailing agent bubble (if same agent) or starts a new one.
 */
function applyEvent(prev: TestMessage[], ev: any): TestMessage[] {
  const last = prev[prev.length - 1];

  if (ev.type === 'text') {
    const agent: AgentRef = ev.agent ?? { id: 'unknown', name: 'Agent' };
    if (last?.role === 'agent' && last.agent?.id === agent.id) {
      return [
        ...prev.slice(0, -1),
        { ...last, text: (last.text || '') + (ev.content ?? ''), streaming: true, agent },
      ];
    }
    // New agent bubble.
    return [
      ...prev,
      {
        id: uid(),
        role: 'agent',
        text: ev.content ?? '',
        agent,
        toolCalls: [],
        streaming: true,
      },
    ];
  }

  if (ev.type === 'tool') {
    const agent: AgentRef = ev.agent ?? { id: 'unknown', name: 'Agent' };
    const call: ToolCall = { id: uid(), name: ev.name, input: ev.input };
    if (last?.role === 'agent' && last.agent?.id === agent.id) {
      return [
        ...prev.slice(0, -1),
        { ...last, toolCalls: [...(last.toolCalls ?? []), call] },
      ];
    }
    // Tool from a new participant — create an empty bubble to host it.
    return [
      ...prev,
      {
        id: uid(),
        role: 'agent',
        text: '',
        agent,
        toolCalls: [call],
        streaming: true,
      },
    ];
  }

  if (ev.type === 'notice') {
    const agent: AgentRef = ev.agent ?? { id: 'unknown', name: 'Agent' };
    const note: Notice = { id: uid(), text: ev.text ?? '' };
    if (last?.role === 'agent' && last.agent?.id === agent.id) {
      return [
        ...prev.slice(0, -1),
        { ...last, notices: [...(last.notices ?? []), note] },
      ];
    }
    // No matching bubble — create a standalone one to host the note.
    return [
      ...prev,
      {
        id: uid(),
        role: 'agent',
        text: '',
        agent,
        toolCalls: [],
        notices: [note],
        streaming: false,
      },
    ];
  }

  if (ev.type === 'error') {
    return [...prev, { id: uid(), role: 'error', text: ev.message || 'Agent error' }];
  }

  if (ev.type === 'done') {
    // Flip any trailing streaming bubbles off.
    return prev.map(m => m.streaming ? { ...m, streaming: false } : m);
  }

  // Unknown event type — ignore.
  return prev;
}
