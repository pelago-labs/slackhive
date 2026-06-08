'use client';

/**
 * @fileoverview Shared UI kit — the small set of primitives that give the app a
 * consistent, premium look (OpenAI-dashboard aesthetic): hairline cards, icon
 * tiles, a unified button set, and page/section headers. All inline-styled with
 * the design tokens in globals.css, so light/dark themes work automatically.
 *
 * Adopt these instead of re-defining card/button styles per page.
 *
 * @module web/components/ui
 */

import React from 'react';

// ─── Card ───────────────────────────────────────────────────────────────────

/**
 * A hairline-bordered surface card. `hover` makes it lift on hover (use for
 * clickable cards). Optional `title`/`action` render a header row.
 */
export function Card({
  children, title, action, hover, onClick, className, style,
}: {
  children: React.ReactNode;
  title?: React.ReactNode;
  action?: React.ReactNode;
  hover?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      onClick={onClick}
      className={`ui-card${hover ? ' ui-card-hover' : ''}${className ? ` ${className}` : ''}`}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, boxShadow: 'var(--shadow-sm)', padding: '18px 20px',
        ...style,
      }}
    >
      {(title || action) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          {typeof title === 'string'
            ? <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>{title}</h3>
            : title}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

// ─── IconTile ─────────────────────────────────────────────────────────────────

/**
 * The reference dashboard's signature: a rounded-square tile with a light-gray
 * background holding a single line icon. Pass a lucide icon as children.
 */
export function IconTile({ children, size = 40, style }: {
  children: React.ReactNode; size?: number; style?: React.CSSProperties;
}) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0, borderRadius: 10,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--muted)', ...style,
    }}>
      {children}
    </div>
  );
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

const btnBase: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
  fontFamily: 'var(--font-sans)', letterSpacing: '-0.01em', cursor: 'pointer',
  transition: 'opacity 0.15s, background 0.15s, border-color 0.15s, color 0.15s',
  whiteSpace: 'nowrap',
};

/** Solid accent button (primary action). */
export function PrimaryBtn({ children, onClick, disabled, type, style }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean;
  type?: 'button' | 'submit'; style?: React.CSSProperties;
}) {
  return (
    <button
      type={type ?? 'button'} onClick={onClick} disabled={disabled}
      style={{
        ...btnBase,
        background: disabled ? 'var(--border)' : 'var(--accent)',
        color: 'var(--accent-fg)', border: '1px solid transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: disabled ? 'none' : 'var(--shadow-sm)',
        ...style,
      }}
      onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLElement).style.opacity = '0.9'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
    >{children}</button>
  );
}

/** Hairline secondary button. */
export function GhostBtn({ children, onClick, disabled, type, style }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean;
  type?: 'button' | 'submit'; style?: React.CSSProperties;
}) {
  return (
    <button
      type={type ?? 'button'} onClick={onClick} disabled={disabled}
      style={{
        ...btnBase, fontWeight: 500,
        background: 'transparent', color: 'var(--muted)',
        border: '1px solid var(--border-2)',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
        ...style,
      }}
      onMouseEnter={e => { if (!disabled) { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; } }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
    >{children}</button>
  );
}

/** Square icon-only button. */
export function IconBtn({ children, onClick, title, active, style }: {
  children: React.ReactNode; onClick?: () => void; title?: string;
  active?: boolean; style?: React.CSSProperties;
}) {
  return (
    <button
      type="button" onClick={onClick} title={title}
      style={{
        width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--font-sans)',
        background: active ? 'var(--surface-2)' : 'var(--surface)',
        border: '1px solid var(--border)', color: active ? 'var(--text)' : 'var(--muted)',
        transition: 'background 0.15s, border-color 0.15s, color 0.15s', ...style,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
      onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'var(--surface)'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; } }}
    >{children}</button>
  );
}

// ─── Headers ──────────────────────────────────────────────────────────────────

/** Page-level title + subtitle, with an optional right-aligned action. */
export function PageHeader({ title, subtitle, action }: {
  title: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>{title}</h1>
        {subtitle && <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>{subtitle}</p>}
      </div>
      {action && <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>{action}</div>}
    </div>
  );
}

/** Small uppercase section label, optionally followed by a hairline divider. */
export function SectionLabel({ children, divider }: { children: React.ReactNode; divider?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--subtle)', whiteSpace: 'nowrap' }}>{children}</span>
      {divider && <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />}
    </div>
  );
}
