'use client';

/**
 * @fileoverview Domain UI primitives layered on the shadcn kit (`components/ui/*`)
 * + design tokens — the app-specific patterns that were previously reinvented
 * inline across pages: page shell/header, status pill, metric card, empty state,
 * spinner, token chip, avatar + stack. Adopt these instead of bespoke style
 * objects so spacing/type/color stay consistent in both themes.
 *
 * @module web/components/patterns
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { initials, avatarColor } from '@/lib/avatar';

// ─── Page shell + headers ─────────────────────────────────────────────────────

/** One shared page wrapper: centered max-width column + responsive padding +
 * entrance animation. Replaces the per-page `<div style={{padding,maxWidth}}>`. */
export function PageShell({ children, maxWidth = 1600, className }: {
  children: React.ReactNode; maxWidth?: number; className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn('fade-up mx-auto w-full px-5 py-8 md:px-10 md:py-9', className)}
      style={{ maxWidth }}
    >
      {children}
    </div>
  );
}

/** Page title + subtitle with optional right-aligned action. */
export function PageHeader({ title, subtitle, action }: {
  title: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-3xl font-bold text-foreground">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2.5">{action}</div>}
    </div>
  );
}

/** Small uppercase section label, optionally followed by a hairline divider. */
export function SectionLabel({ children, divider }: { children: React.ReactNode; divider?: boolean }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="whitespace-nowrap text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{children}</span>
      {divider && <div className="h-px flex-1 bg-border" />}
    </div>
  );
}

// ─── Status pill ────────────────────────────────────────────────────────────

export type Status = 'in_progress' | 'active' | 'running' | 'done' | 'ok' | 'error' | 'failed' | 'queued' | 'idle';

const STATUS_META: Record<Status, { label: string; dot: string; text: string; pulse?: boolean }> = {
  in_progress: { label: 'Running', dot: 'bg-blue', text: 'text-blue', pulse: true },
  active:      { label: 'Active',  dot: 'bg-blue', text: 'text-blue', pulse: true },
  running:     { label: 'Running', dot: 'bg-blue', text: 'text-blue', pulse: true },
  done:        { label: 'Done',    dot: 'bg-green', text: 'text-green' },
  ok:          { label: 'OK',      dot: 'bg-green', text: 'text-green' },
  error:       { label: 'Error',   dot: 'bg-red', text: 'text-red' },
  failed:      { label: 'Failed',  dot: 'bg-red', text: 'text-red' },
  queued:      { label: 'Queued',  dot: 'bg-amber', text: 'text-amber' },
  idle:        { label: 'Idle',    dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
};

/** Status dot + label, used across the kanban / trace / observability views. */
export function StatePill({ status, label, className }: { status: Status; label?: string; className?: string }): React.JSX.Element {
  const m = STATUS_META[status] ?? STATUS_META.idle;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-2xs font-semibold', m.text, className)}>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', m.dot, m.pulse && 'status-running')} />
      {label ?? m.label}
    </span>
  );
}

// ─── Metric card ──────────────────────────────────────────────────────────────

/** KPI tile: label + big value + optional sub/hint. Clickable when onClick set. */
export function MetricCard({ label, value, sub, icon, onClick, className }: {
  label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode;
  icon?: React.ReactNode; onClick?: () => void; className?: string;
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-lg border border-border bg-card p-4 shadow-sm transition-colors',
        onClick && 'metric-clickable',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div className="mt-1.5 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ─── Token chip ────────────────────────────────────────────────────────────────

/** Compact monospace stat chip (token counts, ids). */
export function TokenChip({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground', className)}>
      {children}
    </span>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────────

/** Dashed-border empty placeholder with optional icon + action. */
export function EmptyState({ icon, title, hint, action, className }: {
  icon?: React.ReactNode; title: React.ReactNode; hint?: React.ReactNode;
  action?: React.ReactNode; className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center', className)}>
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <div className="text-sm font-medium text-foreground">{title}</div>
      {hint && <div className="max-w-sm text-2xs text-muted-foreground">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ─── Spinner / loading ───────────────────────────────────────────────────────

/** Inline spinner, sized to context. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }): React.JSX.Element {
  return <Loader2 size={size} className={cn('animate-spin text-muted-foreground', className)} />;
}

/** Centered "Loading…" row. */
export function LoadingRow({ label = 'Loading…' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Spinner /> {label}
    </div>
  );
}

// ─── Avatar + stack ──────────────────────────────────────────────────────────

/** Initials avatar with deterministic color + optional status dot. */
export function Avatar({ id, name, size = 30, status, className }: {
  id: string; name: string; size?: number; status?: 'in_progress' | 'done' | 'error' | 'idle'; className?: string;
}): React.JSX.Element {
  const dot = status === 'in_progress' ? 'bg-blue' : status === 'error' ? 'bg-red' : status === 'done' ? 'bg-green' : null;
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center rounded-full font-bold text-white"
        style={{ background: avatarColor(id), fontSize: Math.round(size * 0.4) }}
      >
        {initials(name)}
      </div>
      {dot && <span className={cn('absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full border-2 border-card', dot)} />}
    </div>
  );
}

/** Overlapping avatar stack (assignees). */
export function AvatarStack({ items, size = 24, max = 4 }: {
  items: { id: string; name: string }[]; size?: number; max?: number;
}): React.JSX.Element {
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((it, i) => (
        <div key={it.id} className="rounded-full ring-2 ring-card" style={{ marginLeft: i === 0 ? 0 : -size * 0.3, zIndex: shown.length - i }}>
          <Avatar id={it.id} name={it.name} size={size} />
        </div>
      ))}
      {extra > 0 && (
        <div
          className="flex items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground ring-2 ring-card"
          style={{ width: size, height: size, marginLeft: -size * 0.3, fontSize: Math.round(size * 0.36) }}
        >
          +{extra}
        </div>
      )}
    </div>
  );
}
