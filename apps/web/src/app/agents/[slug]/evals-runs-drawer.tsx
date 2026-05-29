'use client';

/**
 * @fileoverview Notion-style drawer listing an agent's past regression
 * runs. Click a row to load that run's full results into the main
 * EvalsPanel view.
 *
 * Reuses the same Portal + overlay + slide-in pattern as the cases drawer.
 *
 * @module web/app/agents/[slug]/evals-runs-drawer
 */

import { useCallback, useEffect, useState } from 'react';
import type { Agent, EvalRun } from '@slackhive/shared';
import { Loader2, X } from 'lucide-react';
import { Portal } from '@/lib/portal';
import { relativeTime } from '@/lib/evals/format';

const HISTORY_LIMIT = 30;

interface DrawerProps {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  /** Run currently shown in the main panel — highlighted in the list. */
  currentRunId?: string | null;
  /** Called when the user picks a row. Drawer closes itself afterward. */
  onRunSelected: (runId: string) => void;
}

export function EvalsRunsDrawer({
  agent,
  open,
  onClose,
  currentRunId,
  onRunSelected,
}: DrawerProps) {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}/evals/runs?limit=${HISTORY_LIMIT}`);
      if (r.ok) setRuns((await r.json()) as EvalRun[]);
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) onClose();
    }
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Portal>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 100 }}
      />
      <aside
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 540,
          maxWidth: '92vw',
          background: 'var(--surface)',
          boxShadow: '-12px 0 40px rgba(0,0,0,0.18)',
          zIndex: 101,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 22px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600 }}>Run history</span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 6,
              lineHeight: 1,
              display: 'inline-flex',
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
          {loading && runs.length === 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              <Loader2
                size={14}
                style={{ animation: 'spin 0.8s linear infinite' }}
              />
              Loading runs…
            </div>
          )}

          {!loading && runs.length === 0 && (
            <div
              style={{
                border: '1px dashed var(--border-2)',
                borderRadius: 10,
                padding: '32px 16px',
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 500, color: 'var(--text-2)', marginBottom: 4 }}>
                No runs yet
              </div>
              Click <em>Run regression</em> in the panel to start your first run.
            </div>
          )}

          {runs.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
                {runs.length === HISTORY_LIMIT
                  ? `${HISTORY_LIMIT} most recent runs`
                  : `${runs.length} run${runs.length === 1 ? '' : 's'}`}{' '}
                · click to load into the panel
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
                {runs.map((r, idx) => (
                  <RunRow
                    key={r.id}
                    run={r}
                    current={r.id === currentRunId}
                    isLast={idx === runs.length - 1}
                    onClick={() => {
                      onRunSelected(r.id);
                      onClose();
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </aside>
    </Portal>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function RunRow({
  run,
  current,
  isLast,
  onClick,
}: {
  run: EvalRun;
  current: boolean;
  isLast: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        padding: '11px 14px',
        cursor: 'pointer',
        borderBottom: isLast ? 'none' : '1px solid var(--border)',
        background: current ? 'var(--surface-2)' : 'transparent',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: current ? 600 : 500 }}>
          {relativeTime(run.startedAt)}
          {current && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                color: 'var(--muted)',
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              · current
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          by {run.triggeredBy}
          {run.totalMs != null && ` · ${(run.totalMs / 1000).toFixed(1)}s`}
          {run.status === 'running' && ' · running…'}
          {run.status === 'error' && ' · errored'}
        </div>
      </div>
      <RunPills run={run} />
    </div>
  );
}

function RunPills({ run }: { run: EvalRun }) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <Pill count={run.passCount} color="var(--green)" bg="#dcfce7" />
      <Pill count={run.failCount} color="var(--red)" bg="#fee2e2" />
      <Pill count={run.suspectCount} color="var(--amber)" bg="#fef3c7" />
      <Pill count={run.infraCount} color="var(--muted)" bg="var(--surface-2)" />
    </div>
  );
}

function Pill({ count, color, bg }: { count: number; color: string; bg: string }) {
  const muted = count === 0;
  return (
    <span
      style={{
        minWidth: 22,
        textAlign: 'center',
        padding: '2px 7px',
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        borderRadius: 10,
        background: muted ? 'transparent' : bg,
        color: muted ? 'var(--subtle)' : color,
        border: muted ? '1px solid var(--border)' : 'none',
      }}
    >
      {count}
    </span>
  );
}

