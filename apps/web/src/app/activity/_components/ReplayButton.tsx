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
import { cn } from '@/lib/utils';

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
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border-0 px-3 py-1.5 text-xs font-semibold',
          ok ? 'bg-green/10 text-green' : 'bg-red/10 text-red',
          busy ? 'cursor-default opacity-70' : 'cursor-pointer',
        )}
      >
        {icon}
        {label}
      </button>
    );
  }

  return (
    <div className="group relative">
      <button
        onClick={handleReplay}
        disabled={busy}
        aria-label={label}
        className={cn(
          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-0',
          ok ? 'bg-green/10 text-green' : 'bg-red/10 text-red',
          busy ? 'cursor-default opacity-50' : 'cursor-pointer',
        )}
      >
        {icon}
      </button>
      <span className="pointer-events-none absolute bottom-full right-0 mb-1 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-2xs font-semibold text-background opacity-0 transition-opacity duration-100 group-hover:opacity-100">
        {label}
      </span>
    </div>
  );
}
