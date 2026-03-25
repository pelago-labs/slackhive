'use client';

/**
 * @fileoverview Sidebar navigation component.
 * Client component — uses hover event handlers for interactive nav items.
 *
 * @module web/app/sidebar
 */

import Link from 'next/link';

/**
 * Fixed left sidebar with logo, nav items, and footer links.
 *
 * @returns {JSX.Element}
 */
export function Sidebar() {
  return (
    <aside style={{
      width: 220, flexShrink: 0,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 50,
    }}>
      {/* Logo */}
      <div style={{ padding: '20px 18px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8, flexShrink: 0,
            background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, color: '#fff',
          }}>A</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', letterSpacing: '-0.01em' }}>
              AgentTeam
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: -1 }}>
              Claude Code Platform
            </div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <NavLabel>Agents</NavLabel>
        <NavItem href="/" icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="6" height="6" rx="1.5" fill="currentColor" opacity=".8"/>
            <rect x="9" y="1" width="6" height="6" rx="1.5" fill="currentColor" opacity=".8"/>
            <rect x="1" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity=".8"/>
            <rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity=".8"/>
          </svg>
        }>Dashboard</NavItem>
        <NavItem href="/agents/new" icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        } accent>New Agent</NavItem>

        <div style={{ borderTop: '1px solid var(--border)', margin: '10px 4px' }} />

        <NavLabel>Platform</NavLabel>
        <NavItem href="/settings/mcps" icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M11.54 3.05l-1.41 1.41M3.05 11.54l1.41 1.41"
              stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        }>MCP Catalog</NavItem>
      </nav>

      {/* Footer */}
      <div style={{ padding: '12px 10px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 1 }}>
        <a
          href="https://github.com/amansrivastava17/slack-claude-code-agent-team"
          target="_blank" rel="noopener noreferrer"
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 7, textDecoration: 'none', color: 'var(--muted)', fontSize: 12.5 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHub
        </a>
        <div style={{ padding: '6px 8px', color: 'var(--subtle)', fontSize: 11 }}>
          v0.1.0 · MIT License
        </div>
      </div>
    </aside>
  );
}

function NavLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 600, letterSpacing: '0.07em',
      color: 'var(--subtle)', textTransform: 'uppercase' as const,
      padding: '6px 8px 3px', marginTop: 4,
    }}>{children}</div>
  );
}

function NavItem({ href, icon, children, accent }: {
  href: string; icon?: React.ReactNode; children: React.ReactNode; accent?: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 8px', borderRadius: 7, textDecoration: 'none',
        color: accent ? 'var(--accent)' : 'var(--muted)',
        fontSize: 13, fontWeight: accent ? 500 : 400,
        transition: 'color 0.15s, background 0.15s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.color = accent ? 'var(--accent)' : 'var(--text)';
        (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.color = accent ? 'var(--accent)' : 'var(--muted)';
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {icon && <span style={{ opacity: 0.8, flexShrink: 0 }}>{icon}</span>}
      {children}
    </Link>
  );
}
