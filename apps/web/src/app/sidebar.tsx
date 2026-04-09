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
import type { Agent } from '@slackhive/shared';
import { useAuth } from '@/lib/auth-context';

const STATUS_DOT: Record<string, string> = {
  running: '#059669', stopped: '#d4d4d4', error: '#dc2626',
};

export const SidebarContext = createContext<{ collapsed: boolean; width: number }>({ collapsed: false, width: 240 });

const W_OPEN = 240;
const W_CLOSED = 56;

export function Sidebar({ children, mobileOpen, onMobileClose }: { children?: React.ReactNode; mobileOpen?: boolean; onMobileClose?: () => void }) {
  const pathname = usePathname();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [branding, setBranding] = useState({ appName: 'SlackHive', tagline: 'AI agent teams on Slack', logoUrl: '' });
  const { username, role, canEdit, logout } = useAuth();
  const w = isMobile ? 0 : (collapsed ? W_CLOSED : W_OPEN);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

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
      {/* Mobile overlay backdrop */}
      {isMobile && mobileOpen && (
        <div onClick={onMobileClose} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
          zIndex: 49, backdropFilter: 'blur(2px)',
        }} />
      )}
      <aside style={{
        width: W_OPEN, flexShrink: 0, background: '#fff',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        position: 'fixed', top: 0, bottom: 0, zIndex: 50,
        left: isMobile ? (mobileOpen ? 0 : -W_OPEN) : (collapsed ? 0 : 0),
        ...(isMobile ? {} : { width: collapsed ? W_CLOSED : W_OPEN }),
        transition: isMobile ? 'left 0.25s cubic-bezier(0.16,1,0.3,1)' : 'width 0.2s cubic-bezier(0.16,1,0.3,1)',
        overflow: 'hidden',
        ...(isMobile && mobileOpen ? { boxShadow: 'var(--shadow-lg)' } : {}),
      }}>

        {/* ── Brand ──────────────────────────────────────────────────────── */}
        <div style={{
          padding: collapsed ? '14px 0' : '18px 20px 14px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: 10, minHeight: 56,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={branding.logoUrl || '/logo.svg'}
            alt="Logo"
            style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, objectFit: 'cover' }}
          />
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
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* Scrollable agents section */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 4px' }}>
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
                  padding: collapsed ? '7px 0' : '8px 12px',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  borderRadius: 'var(--radius)', textDecoration: 'none', marginBottom: 2,
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

          {canEdit && <Link href="/agents/new" title="Add agent" style={{
            display: 'flex', alignItems: 'center',
            gap: 8, padding: collapsed ? '7px 0' : '8px 12px',
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
          </Link>}

        </div>

        {/* Fixed bottom nav — always visible */}
        <div style={{ padding: '4px 12px 8px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>

          <NavItem href="/settings/mcps" active={pathname === '/settings/mcps'} collapsed={collapsed} icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M5.5 8h5M8 5.5v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          }>MCP Catalog</NavItem>

          <NavItem href="/settings/env-vars" active={pathname === '/settings/env-vars'} collapsed={collapsed} icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="5" width="12" height="8" rx="2" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M5 5V4a3 3 0 016 0v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <circle cx="8" cy="9" r="1.2" fill="currentColor"/>
            </svg>
          }>Env Vars</NavItem>

          <NavItem href="/jobs" active={pathname === '/jobs'} collapsed={collapsed} icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          }>Jobs</NavItem>

          <NavItem href="/settings" active={pathname === '/settings'} collapsed={collapsed} icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6.86 2h2.28l.32 1.6a5 5 0 011.32.77l1.54-.52.94 1.62-1.22 1.08a5 5 0 010 1.54l1.22 1.08-.94 1.62-1.54-.52a5 5 0 01-1.32.77L9.14 14H6.86l-.32-1.6a5 5 0 01-1.32-.77l-1.54.52-.94-1.62 1.22-1.08a5 5 0 010-1.54L2.74 6.83l.94-1.62 1.54.52a5 5 0 011.32-.77L6.86 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          }>Settings</NavItem>
        </div>
        </div>

        {/* ── Footer — Profile ──────────────────────────────────────────── */}
        <div style={{ padding: collapsed ? '12px 8px' : '12px', borderTop: '1px solid var(--border)', position: 'relative' }}>
          {/* Profile row — click to toggle popup */}
          <div
            onClick={() => setProfileOpen(p => !p)}
            style={{
              display: 'flex', alignItems: 'center',
              gap: 10, padding: collapsed ? '4px 0' : '8px 10px',
              justifyContent: collapsed ? 'center' : 'flex-start',
              borderRadius: 8, cursor: 'pointer',
              transition: 'background 0.12s',
              background: profileOpen ? 'var(--surface-2)' : 'transparent',
            }}
            onMouseEnter={e => { if (!profileOpen) e.currentTarget.style.background = 'var(--surface-2)'; }}
            onMouseLeave={e => { if (!profileOpen) e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: '#171717',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 600, color: '#fff',
            }}>
              {(username || '?').charAt(0).toUpperCase()}
            </div>
            {!collapsed && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, fontWeight: 500, color: 'var(--text)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{username}</div>
                <div style={{ fontSize: 11, color: 'var(--subtle)', textTransform: 'capitalize' }}>{role}</div>
              </div>
            )}
            {!collapsed && (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, color: 'var(--subtle)', transform: profileOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>

          {/* Popup menu */}
          {profileOpen && (
            <div style={{
              position: 'absolute',
              bottom: collapsed ? 60 : 64,
              left: collapsed ? 8 : 12,
              right: collapsed ? 8 : 12,
              background: '#fff',
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
              zIndex: 60,
              minWidth: collapsed ? 160 : undefined,
            }}>
              {collapsed && (
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{username}</div>
                  <div style={{ fontSize: 11, color: 'var(--subtle)', textTransform: 'capitalize' }}>{role}</div>
                </div>
              )}
              <button
                onClick={() => { setProfileOpen(false); logout(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '10px 14px',
                  background: 'transparent', border: 'none',
                  color: '#dc2626', fontSize: 13, cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(220,38,38,0.05)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path d="M6 2H4a2 2 0 00-2 2v8a2 2 0 002 2h2M11 11l3-3-3-3M14 8H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>
      {children}
    </SidebarContext.Provider>
  );
}

function NavItem({ href, icon, children, active, collapsed, onClick }: {
  href?: string; icon?: React.ReactNode; children: React.ReactNode; active?: boolean; collapsed?: boolean; onClick?: () => void;
}) {
  const style: React.CSSProperties = {
    display: 'flex', alignItems: 'center',
    gap: 9, padding: collapsed ? '8px 0' : '9px 12px',
    justifyContent: collapsed ? 'center' : 'flex-start',
    borderRadius: 'var(--radius)', textDecoration: 'none', border: 'none',
    color: active ? 'var(--text)' : 'var(--muted)',
    background: active ? 'var(--surface-3)' : 'transparent',
    fontSize: 13, fontWeight: active ? 600 : 400,
    transition: 'background 0.12s, color 0.12s',
    cursor: 'pointer', width: '100%', fontFamily: 'var(--font-sans)',
  };
  const hover = (e: React.MouseEvent) => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }};
  const leave = (e: React.MouseEvent) => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }};
  const content = <>{icon && <span style={{ flexShrink: 0 }}>{icon}</span>}{!collapsed && children}</>;

  if (onClick) {
    return <button onClick={onClick} title={collapsed ? String(children) : undefined} style={style} onMouseEnter={hover} onMouseLeave={leave}>{content}</button>;
  }
  return <Link href={href || '/'} title={collapsed ? String(children) : undefined} style={style} onMouseEnter={hover} onMouseLeave={leave}>{content}</Link>;
}
