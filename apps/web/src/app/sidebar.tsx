'use client';

/**
 * @fileoverview Collapsible sidebar with branding, live agent list, and nav.
 * Collapse toggle is in the footer.
 *
 * @module web/app/sidebar
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, createContext } from 'react';
import type { Agent } from '@slack-agent-team/shared';

const STATUS_DOT: Record<string, string> = {
  running: '#059669', stopped: '#d4d4d4', error: '#dc2626',
};

export const SidebarContext = createContext<{ collapsed: boolean; width: number }>({ collapsed: false, width: 240 });

const W_OPEN = 240;
const W_CLOSED = 56;

export function Sidebar({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [branding, setBranding] = useState({ appName: 'AI Teams', tagline: 'Claude Code Platform', logoUrl: '' });
  const w = collapsed ? W_CLOSED : W_OPEN;

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(setAgents).catch(() => {});
    fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => {
      setBranding(prev => ({
        appName: s.appName || prev.appName,
        tagline: s.tagline || prev.tagline,
        logoUrl: s.logoUrl ?? prev.logoUrl,
      }));
    }).catch(() => {});
  }, []);

  return (
    <SidebarContext.Provider value={{ collapsed, width: w }}>
      <aside style={{
        width: w, flexShrink: 0, background: '#fff',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 50,
        transition: 'width 0.2s cubic-bezier(0.16,1,0.3,1)',
        overflow: 'hidden',
      }}>

        {/* ── Brand ──────────────────────────────────────────────────────── */}
        <div style={{
          padding: collapsed ? '14px 0' : '18px 20px 14px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: 10, minHeight: 56,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8, flexShrink: 0,
            background: branding.logoUrl ? 'transparent' : '#e5e5e5',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden',
          }}>
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt="Logo" style={{ width: 28, height: 28, objectFit: 'cover' }} />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" fill="#a3a3a3"/>
                <path d="M9 11h6a5 5 0 015 5v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2a5 5 0 015-5z" fill="#a3a3a3"/>
                <circle cx="17" cy="6" r="3" fill="#d4d4d4" stroke="#e5e5e5" strokeWidth="1"/>
                <path d="M15.5 6h3M17 4.5v3" stroke="#a3a3a3" strokeWidth="0.8" strokeLinecap="round"/>
              </svg>
            )}
          </div>
          {!collapsed && (
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
                {branding.appName}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: -1, whiteSpace: 'nowrap' }}>
                {branding.tagline}
              </div>
            </div>
          )}
        </div>

        {/* ── Nav ─────────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 12px' }}>

          <NavItem href="/" active={pathname === '/'} collapsed={collapsed} icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="1.5" width="5" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="9.5" y="1.5" width="5" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="1.5" y="9.5" width="5" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="9.5" y="9.5" width="5" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          }>Dashboard</NavItem>

          {!collapsed && (
            <div style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
              color: 'var(--subtle)', textTransform: 'uppercase',
              padding: '16px 10px 6px',
            }}>Agents</div>
          )}
          {collapsed && <div style={{ height: 1, background: 'var(--border)', margin: '10px 4px' }} />}

          {agents.length === 0 && !collapsed && (
            <div style={{ padding: '6px 10px', fontSize: 12.5, color: 'var(--subtle)', fontStyle: 'italic' }}>
              No agents yet
            </div>
          )}

          {agents.map(agent => {
            const isActive = pathname === `/agents/${agent.slug}`;
            const dot = STATUS_DOT[agent.status] ?? '#d4d4d4';
            return (
              <Link key={agent.id} href={`/agents/${agent.slug}`} title={agent.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: collapsed ? '6px 0' : '7px 10px',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  borderRadius: 8, textDecoration: 'none', marginBottom: 2,
                  background: isActive ? 'var(--surface-2)' : 'transparent',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 8,
                    background: agent.isBoss ? '#171717' : 'var(--surface-2)',
                    border: agent.isBoss ? 'none' : '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 600, color: agent.isBoss ? '#fff' : 'var(--text)',
                  }}>{agent.name.charAt(0).toUpperCase()}</div>
                  <div className={agent.status === 'running' ? 'status-running' : ''} style={{
                    position: 'absolute', bottom: -1, right: -1,
                    width: 8, height: 8, borderRadius: '50%',
                    background: dot, border: '2px solid #fff',
                  }} />
                </div>
                {!collapsed && (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      fontSize: 13, fontWeight: isActive ? 600 : 400, color: 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {agent.name}
                      {agent.isBoss && (
                        <span style={{
                          fontSize: 9, fontWeight: 600, color: '#d97706',
                          background: 'rgba(217,119,6,0.1)',
                          padding: '1px 4px', borderRadius: 3,
                          letterSpacing: '0.04em', flexShrink: 0,
                        }}>BOSS</span>
                      )}
                    </div>
                  </div>
                )}
              </Link>
            );
          })}

          <Link href="/agents/new" title="Add agent" style={{
            display: 'flex', alignItems: 'center',
            gap: 8, padding: collapsed ? '6px 0' : '7px 10px',
            justifyContent: collapsed ? 'center' : 'flex-start',
            borderRadius: 8, textDecoration: 'none',
            color: 'var(--muted)', fontSize: 13, marginTop: 4,
            transition: 'color 0.12s, background 0.12s',
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            {!collapsed && 'Add agent'}
          </Link>

          <div style={{ height: 1, background: 'var(--border)', margin: '12px 6px' }} />

          <NavItem href="/settings/mcps" active={pathname === '/settings/mcps'} collapsed={collapsed} icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M5.5 8h5M8 5.5v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          }>MCP Catalog</NavItem>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div style={{ padding: collapsed ? '10px 8px' : '10px 12px 14px', borderTop: '1px solid var(--border)' }}>
          {/* Settings */}
          <NavItem href="/settings" active={pathname === '/settings'} collapsed={collapsed} icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6.86 2h2.28l.32 1.6a5 5 0 011.32.77l1.54-.52.94 1.62-1.22 1.08a5 5 0 010 1.54l1.22 1.08-.94 1.62-1.54-.52a5 5 0 01-1.32.77L9.14 14H6.86l-.32-1.6a5 5 0 01-1.32-.77l-1.54.52-.94-1.62 1.22-1.08a5 5 0 010-1.54L2.74 6.83l.94-1.62 1.54.52a5 5 0 011.32-.77L6.86 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          }>Settings</NavItem>

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(c => !c)}
            style={{
              display: 'flex', alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'flex-start',
              gap: 8, width: '100%',
              padding: collapsed ? '8px 0' : '7px 10px',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--muted)', fontSize: 12.5, cursor: 'pointer',
              transition: 'color 0.12s, background 0.12s',
              fontFamily: 'var(--font-sans)',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {!collapsed && 'Collapse'}
          </button>

          {!collapsed && (
            <>
              <a href="https://github.com/amansrivastava17/slack-claude-code-agent-team"
                target="_blank" rel="noopener noreferrer"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px', borderRadius: 7, textDecoration: 'none',
                  color: 'var(--muted)', fontSize: 12.5,
                  transition: 'color 0.12s, background 0.12s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
                GitHub
              </a>
              <div style={{ padding: '4px 10px', color: 'var(--subtle)', fontSize: 11 }}>v0.1.0</div>
            </>
          )}
        </div>
      </aside>
      {children}
    </SidebarContext.Provider>
  );
}

function NavItem({ href, icon, children, active, collapsed }: {
  href: string; icon?: React.ReactNode; children: React.ReactNode; active?: boolean; collapsed?: boolean;
}) {
  return (
    <Link href={href} title={collapsed ? String(children) : undefined}
      style={{
        display: 'flex', alignItems: 'center',
        gap: 9, padding: collapsed ? '8px 0' : '8px 10px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: 8, textDecoration: 'none',
        color: active ? 'var(--text)' : 'var(--muted)',
        background: active ? 'var(--surface-2)' : 'transparent',
        fontSize: 13, fontWeight: active ? 600 : 400,
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}}
      onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }}}
    >
      {icon && <span style={{ flexShrink: 0 }}>{icon}</span>}
      {!collapsed && children}
    </Link>
  );
}
