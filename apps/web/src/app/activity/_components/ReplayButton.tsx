'use client';

/**
 * @fileoverview Replay control for a failed activity — re-runs the original
 * message through the agent's live MessageHandler via POST /api/activity/[taskId]/replay.
 *
 * One component, two looks: `icon` (24×24 with hover tooltip, used on the kanban
 * cards) and `labeled` (text button, used on the task-detail activity cards). Both
 * share the same fetch contract and state machine so the two views can't drift.
 *
 * @module web/app/activity/_components/ReplayButton
 */

import React, { useState } from 'react';
import { RotateCcw, Loader2, CheckCircle2 } from 'lucide-react';

type ReplayState = 'idle' | 'replaying' | 'done' | 'error';

const STATUS_TEXT: Record<ReplayState, string> = {
  idle: 'Replay',
  replaying: 'Starting…',
  done: 'Queued',
  error: 'Failed — retry',
};

export function ReplayButton(props: {
  taskId: string;
  /** Omit to let the runner replay the task's most recent error activity. */
  activityId?: string;
  /** `icon` = 24×24 with tooltip (kanban cards); `labeled` = text button (detail). */
  variant?: 'icon' | 'labeled';
}): React.JSX.Element {
  const { taskId, activityId, variant = 'icon' } = props;
  const [state, setState] = useState<ReplayState>('idle');
  const busy = state === 'replaying';

  async function handleReplay(e: React.MouseEvent) {
    // Cards are wrapped in a <Link>; stop the click from navigating.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return; // ignore re-clicks while a request is in flight
    setState('replaying');
    try {
      const res = await fetch(`/api/activity/${encodeURIComponent(taskId)}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activityId ? { activityId } : {}),
      });
      // Settle to a terminal state but keep the button clickable so a replay that
      // itself re-errors can be retried (replays are exempt from the runner's
      // duplicate-delivery window, so a second click genuinely re-runs).
      setState(res.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  }

  const label = STATUS_TEXT[state];
  const icon = busy
    ? <Loader2 size={variant === 'icon' ? 11 : 12} style={{ animation: 'spin 1.2s linear infinite' }} />
    : state === 'done'
      ? <CheckCircle2 size={variant === 'icon' ? 11 : 12} />
      : <RotateCcw size={variant === 'icon' ? 11 : 12} />;
  const ok = state === 'done';

  if (variant === 'labeled') {
    return (
      <button
        onClick={handleReplay}
        disabled={busy}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', borderRadius: 6, border: 'none',
          background: ok ? 'rgba(5,150,105,0.1)' : 'rgba(220,38,38,0.08)',
          color: ok ? '#047857' : '#b91c1c',
          fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.7 : 1,
        }}
      >
        {icon}
        {label}
      </button>
    );
  }

  return (
    <div style={{ position: 'relative' }}
      onMouseEnter={e => { const t = e.currentTarget.querySelector<HTMLElement>('[data-tip]'); if (t) t.style.opacity = '1'; }}
      onMouseLeave={e => { const t = e.currentTarget.querySelector<HTMLElement>('[data-tip]'); if (t) t.style.opacity = '0'; }}
    >
      <button
        onClick={handleReplay}
        disabled={busy}
        aria-label={label}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: 5, border: 'none',
          background: ok ? 'rgba(5,150,105,0.12)' : 'rgba(220,38,38,0.1)',
          color: ok ? '#047857' : '#dc2626',
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.5 : 1,
          flexShrink: 0,
        }}
      >
        {icon}
      </button>
      <span data-tip style={{
        position: 'absolute', bottom: '100%', right: 0, marginBottom: 5,
        background: 'var(--text)', color: 'var(--bg, #fff)',
        fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
        whiteSpace: 'nowrap', pointerEvents: 'none',
        opacity: 0, transition: 'opacity 0.12s',
      }}>
        {label}
      </span>
    </div>
  );
}
