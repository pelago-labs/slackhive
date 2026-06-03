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
import { useTheme } from '@/lib/theme-context';
import { LayoutDashboard, Activity as ActivityIcon, Plus, BookOpen, Blocks, KeyRound, Clock, Settings as SettingsIcon, ChevronDown, FileText, ExternalLink, Sun, Moon, LogOut } from 'lucide-react';

const STATUS_DOT: Record<string, string> = {
  running: '#059669', stopped: '#d4d4d4', error: '#dc2626', stale: '#f59e0b',
};

export const SidebarContext = createContext<{ collapsed: boolean; width: number }>({ collapsed: false, width: 240 });

const W_OPEN = 240;
const W_CLOSED = 56;

export function Sidebar({ children, mobileOpen, onMobileClose }: { children?: React.ReactNode; mobileOpen?: boolean; onMobileClose?: () => void }) {
  const pathname = usePathname();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeTaskCount, setActiveTaskCount] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [branding, setBranding] = useState({ appName: 'SlackHive', tagline: 'AI agent teams on Slack', logoUrl: '' });
  const { username, role, canEdit, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const w = isMobile ? 0 : (collapsed ? W_CLOSED : W_OPEN);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const loadSidebarData = () => {
    fetch('/api/agents').then(r => r.json()).then(setAgents).catch(() => {});
    fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => {
      setBranding(prev => ({
        appName: s.appName || prev.appName,
        tagline: s.tagline || prev.tagline,
        logoUrl: s.logoUrl ?? prev.logoUrl,
      }));
    }).catch(() => {});
    fetch('/api/activity/stats').then(r => r.json()).then((s: { counts?: { active?: number } }) => {
      setActiveTaskCount(s.counts?.active ?? 0);
    }).catch(() => {});
  };

  useEffect(() => {
    loadSidebarData();
    // Poll every 5 seconds to keep sidebar in sync after mutations
    const interval = setInterval(loadSidebarData, 5000);
    // Also listen for instant refresh signals from other components
    const handler = () => loadSidebarData();
    window.addEventListener('slackhive:sidebar-refresh', handler);
    return () => { clearInterval(interval); window.removeEventListener('slackhive:sidebar-refresh', handler); };
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
        width: W_OPEN, flexShrink: 0, background: 'var(--surface)',
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
          <NavItem href="/" active={pathname === '/'} collapsed={collapsed} icon={<LayoutDashboard size={16} strokeWidth={1.75} />}>Dashboard</NavItem>

          {role !== 'viewer' && (
            <NavItem href="/activity" active={pathname === '/activity' || pathname.startsWith('/activity/')} collapsed={collapsed} icon={<ActivityIcon size={16} strokeWidth={1.75} />} badge={activeTaskCount > 0 ? activeTaskCount : undefined}>Activity</NavItem>
          )}

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
            const displayStatus = agent.liveStatus ?? agent.status;
            const dot = STATUS_DOT[displayStatus] ?? '#d4d4d4';
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
                  <div className={displayStatus === 'running' ? 'status-running' : ''} style={{
                    position: 'absolute', bottom: -1, right: -1,
                    width: 8, height: 8, borderRadius: '50%',
                    background: dot, border: '2px solid var(--surface)',
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
            <Plus size={16} strokeWidth={1.75} style={{ flexShrink: 0 }} />
            {!collapsed && 'Add agent'}
          </Link>}

        </div>

        {/* Fixed bottom nav — always visible */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>

          {!collapsed && (
            <div style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
              color: 'var(--subtle)', textTransform: 'uppercase',
              padding: '2px 10px 6px',
            }}>Workspace</div>
          )}

          <NavItem href="/knowledge" active={pathname.startsWith('/knowledge')} collapsed={collapsed} icon={<BookOpen size={16} strokeWidth={1.75} />}>Knowledge</NavItem>

          <NavItem href="/settings/mcps" active={pathname === '/settings/mcps'} collapsed={collapsed} icon={<Blocks size={16} strokeWidth={1.75} />}>MCP Catalog</NavItem>

          <NavItem href="/settings/env-vars" active={pathname === '/settings/env-vars'} collapsed={collapsed} icon={<KeyRound size={16} strokeWidth={1.75} />}>Env Vars</NavItem>

          <NavItem href="/jobs" active={pathname === '/jobs'} collapsed={collapsed} icon={<Clock size={16} strokeWidth={1.75} />}>Jobs</NavItem>

          {role === 'superadmin' && (
            <NavItem href="/settings" active={pathname === '/settings'} collapsed={collapsed} icon={<SettingsIcon size={16} strokeWidth={1.75} />}>Settings</NavItem>
          )}

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
              background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 600, color: 'var(--accent-fg)',
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
              <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--subtle)', transform: profileOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
            )}
          </div>

          {/* Popup menu */}
          {profileOpen && (
            <div style={{
              position: 'absolute',
              bottom: collapsed ? 60 : 64,
              left: collapsed ? 8 : 12,
              right: collapsed ? 8 : 12,
              background: 'var(--surface)',
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
              <a
                href="https://slackhive.mintlify.app"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setProfileOpen(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '10px 14px',
                  background: 'transparent', textDecoration: 'none',
                  color: 'var(--muted)', fontSize: 13,
                  fontFamily: 'var(--font-sans)',
                  transition: 'background 0.12s',
                  borderBottom: '1px solid var(--border)',
                  boxSizing: 'border-box',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <FileText size={15} strokeWidth={1.75} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1 }}>Documentation</span>
                <ExternalLink size={12} style={{ flexShrink: 0, color: 'var(--subtle)' }} />
              </a>
              <button
                onClick={toggleTheme}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '10px 14px',
                  background: 'transparent', border: 'none',
                  color: 'var(--muted)', fontSize: 13, cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  transition: 'background 0.12s',
                  borderBottom: '1px solid var(--border)',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {theme === 'light' ? <Moon size={15} strokeWidth={1.75} /> : <Sun size={15} strokeWidth={1.75} />}
                {theme === 'light' ? 'Dark mode' : 'Light mode'}
              </button>
              <button
                onClick={() => { setProfileOpen(false); logout(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '10px 14px',
                  background: 'transparent', border: 'none',
                  color: 'var(--red)', fontSize: 13, cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--red-soft-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <LogOut size={15} strokeWidth={1.75} />
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

function NavItem({ href, icon, children, active, collapsed, onClick, badge }: {
  href?: string; icon?: React.ReactNode; children: React.ReactNode; active?: boolean; collapsed?: boolean; onClick?: () => void; badge?: number;
}) {
  const style: React.CSSProperties = {
    display: 'flex', alignItems: 'center',
    gap: 9, padding: collapsed ? '8px 0' : '9px 12px',
    justifyContent: collapsed ? 'center' : 'flex-start',
    borderRadius: 'var(--radius)', textDecoration: 'none', border: 'none',
    color: active ? 'var(--text)' : 'var(--muted)',
    background: active ? 'var(--surface-2)' : 'transparent',
    fontSize: 13, fontWeight: active ? 600 : 400,
    transition: 'background 0.12s, color 0.12s',
    cursor: 'pointer', width: '100%', fontFamily: 'var(--font-sans)',
    position: 'relative',
  };
  const hover = (e: React.MouseEvent) => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }};
  const leave = (e: React.MouseEvent) => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }};
  const iconNode = icon && (
    <span style={{ flexShrink: 0, position: 'relative' }}>
      {icon}
      {collapsed && badge !== undefined && badge > 0 && (
        <span className="status-running" style={{
          position: 'absolute', top: -2, right: -4,
          width: 8, height: 8, borderRadius: '50%',
          background: '#2563eb', border: '2px solid var(--surface)',
        }} />
      )}
    </span>
  );
  const content = <>
    {iconNode}
    {!collapsed && <span style={{ flex: 1 }}>{children}</span>}
    {!collapsed && badge !== undefined && badge > 0 && (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        <span className="status-running" style={{
          width: 7, height: 7, borderRadius: '50%', background: '#2563eb',
        }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: '#2563eb' }}>{badge}</span>
      </span>
    )}
  </>;

  if (onClick) {
    return <button onClick={onClick} title={collapsed ? String(children) : undefined} style={style} onMouseEnter={hover} onMouseLeave={leave}>{content}</button>;
  }
  return <Link href={href || '/'} title={collapsed ? String(children) : undefined} style={style} onMouseEnter={hover} onMouseLeave={leave}>{content}</Link>;
}
