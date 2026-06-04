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

/** Small round avatar — accent disc for agents, neutral disc for the user. */
function Avatar({ label, kind }: { label: string; kind: 'user' | 'agent' }) {
  return (
    <div
      style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 600, userSelect: 'none',
        background: kind === 'agent' ? 'var(--accent)' : 'var(--surface-2)',
        color: kind === 'agent' ? 'var(--accent-fg)' : 'var(--text)',
        border: kind === 'user' ? '1px solid var(--border)' : 'none',
      }}
    >
      {(label || '?').charAt(0).toUpperCase()}
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
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  /** ChatGPT-style auto-grow: textarea height tracks content up to a cap. */
  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  // Map of slackBotUserId → agent display name, built from SSE events as they
  // arrive. Used to rewrite `<@Uxxx>` tokens in rendered markdown.
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
    if (taRef.current) taRef.current.style.height = 'auto';
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
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                textAlign: 'center', color: 'var(--muted)', fontSize: 13, lineHeight: 1.6,
                padding: '90px 20px',
              }}
            >
              <div style={{
                width: 52, height: 52, borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-fg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 600, marginBottom: 16,
              }}>
                {(agentName || 'A').charAt(0).toUpperCase()}
              </div>
              <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                Chat with {agentName}
              </div>
              <div style={{ maxWidth: 380 }}>
                Preview only — nothing posts to connected platforms. Tools run live; memory writes aren&apos;t saved.
              </div>
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
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Avatar kind="agent" label={agentName} />
              <div style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic', paddingTop: 4 }}>
                <Loader2 size={12} style={{ display: 'inline', animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
                Thinking…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer — ChatGPT-style rounded pill. */}
      <div
        style={{
          background: 'var(--bg)',
          padding: '8px 20px 16px',
          flexShrink: 0,
        }}
      >
        <div style={{ maxWidth: 780, margin: '0 auto' }}>
          <div
            style={{
              display: 'flex', alignItems: 'flex-end', gap: 8,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 24,
              padding: '7px 7px 7px 16px',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoGrow(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Message your agent…"
              rows={1}
              disabled={sending}
              style={{
                flex: 1,
                minHeight: 24,
                maxHeight: 180,
                padding: '6px 0',
                background: 'transparent',
                color: 'var(--text)',
                border: 'none',
                outline: 'none',
                fontSize: 14,
                lineHeight: 1.5,
                resize: 'none',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              title="Send"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 34, height: 34,
                background: 'var(--accent)',
                color: 'var(--accent-fg)',
                border: 'none',
                borderRadius: '50%',
                cursor: (sending || !input.trim()) ? 'not-allowed' : 'pointer',
                opacity: (sending || !input.trim()) ? 0.4 : 1,
                flexShrink: 0,
                transition: 'opacity 0.15s',
              }}
            >
              {sending ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={15} />}
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--subtle)', textAlign: 'center', marginTop: 8 }}>
            Preview only · Enter to send, Shift+Enter for a new line
          </div>
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
            padding: '10px 15px',
            background: 'var(--surface-2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 18,
            borderBottomRightRadius: 5,
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
        ? 'Delegation chain too long — aborting. Check the boss\u2019s AGENTS.md or the specialist\u2019s reply pattern.'
        : m.text;
    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(220,38,38,0.12)', color: '#dc2626', fontWeight: 700, fontSize: 14,
        }}>!</div>
        <div
          style={{
            flex: 1, minWidth: 0,
            padding: '10px 14px',
            background: 'rgba(220, 38, 38, 0.06)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            color: 'var(--text)',
            borderRadius: 10,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 600, marginBottom: 4, letterSpacing: 0.3 }}>ERROR</div>
          {friendly}
        </div>
      </div>
    );
  }

  // Agent turn — ChatGPT style: avatar gutter + name header + full-width content.
  const rendered = m.text ? renameMentions(m.text, botIdToName) : '';
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      {showAgentHeader
        ? <Avatar kind="agent" label={m.agent?.name ?? 'Agent'} />
        : <div style={{ width: 28, flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        {showAgentHeader && (
          <div
            style={{
              fontSize: 13,
              color: 'var(--text)',
              marginBottom: 3,
              fontWeight: 600,
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
