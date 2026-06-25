'use client';

/**
 * @fileoverview Collapsible sidebar with branding, live agent list, and nav.
 * Collapse toggle is in the footer. Styled with the design-system tokens via
 * Tailwind utilities (hover/active states are CSS, not JS handlers).
 *
 * @module web/app/sidebar
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, createContext } from 'react';
import type { Agent } from '@slackhive/shared';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/lib/theme-context';
import { LayoutDashboard, Activity as ActivityIcon, LineChart, Plus, BookOpen, Blocks, KeyRound, Clock, Settings as SettingsIcon, ChevronDown, FileText, ExternalLink, Sun, Moon, LogOut, PanelLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WhatsNew } from './_components/WhatsNew';

// Run before paint on the client (avoid the SSR no-op warning on the server).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const STATUS_DOT: Record<string, string> = {
  running: 'var(--green)', stopped: 'var(--border-2)', error: 'var(--red)', stale: 'var(--amber)',
};

export const SidebarContext = createContext<{ collapsed: boolean; width: number }>({ collapsed: false, width: 240 });

const W_OPEN = 240;
const W_CLOSED = 56;

export function Sidebar({ children, mobileOpen, onMobileClose }: { children?: React.ReactNode; mobileOpen?: boolean; onMobileClose?: () => void }) {
  const pathname = usePathname();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeTaskCount, setActiveTaskCount] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const toggleCollapsed = () => setCollapsed(c => {
    const next = !c;
    try { localStorage.setItem('slackhive-sidebar-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });
  const [profileOpen, setProfileOpen] = useState(false);
  // Read the persisted collapsed state BEFORE first paint so a collapsed sidebar
  // doesn't flash open then animate shut on reload. `mounted` keeps the width
  // transition off for that first commit so there's no animation on load either.
  const [mounted, setMounted] = useState(false);
  useIsoLayoutEffect(() => {
    try { if (localStorage.getItem('slackhive-sidebar-collapsed') === '1') setCollapsed(true); } catch { /* ignore */ }
  }, []);
  useEffect(() => { setMounted(true); }, []);
  const profileRef = useRef<HTMLDivElement>(null);
  // Close the profile menu on outside click / Escape (it's not portaled, so a
  // backdrop div would be trapped under the sidebar's stacking context).
  useEffect(() => {
    if (!profileOpen) return;
    const onDown = (e: MouseEvent) => { if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setProfileOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [profileOpen]);
  const [isMobile, setIsMobile] = useState(false);
  const [branding, setBranding] = useState({ appName: 'SlackHive', logoUrl: '' });
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
        <div onClick={onMobileClose} className="fixed inset-0 z-[49] bg-black/30 backdrop-blur-[2px]" />
      )}
      <aside
        className={cn(
          'fixed bottom-0 top-0 z-50 flex flex-col overflow-hidden border-r border-border bg-card',
          isMobile && mobileOpen && 'shadow-lg',
        )}
        style={{
          width: isMobile ? W_OPEN : (collapsed ? W_CLOSED : W_OPEN),
          left: isMobile ? (mobileOpen ? 0 : -W_OPEN) : 0,
          transition: !mounted ? 'none' : (isMobile ? 'left 0.25s cubic-bezier(0.16,1,0.3,1)' : 'width 0.2s cubic-bezier(0.16,1,0.3,1)'),
        }}
      >

        {/* ── Brand + collapse toggle (top-right) ───────────────────────── */}
        <div className={cn('flex min-h-[56px] items-center border-b border-border', collapsed ? 'justify-center py-3.5' : 'gap-2.5 px-5 pb-3.5 pt-[18px]')}>
          {collapsed ? (
            // Collapsed: show the logo; reveal the expand toggle on hover.
            <button
              onClick={toggleCollapsed}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-secondary"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={branding.logoUrl || '/logo.svg'} alt="Logo" className="h-7 w-7 rounded-md object-cover transition-opacity group-hover:opacity-0" />
              <PanelLeft size={18} strokeWidth={2} className="absolute text-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={branding.logoUrl || '/logo.svg'} alt="Logo" className="h-7 w-7 shrink-0 rounded-md object-cover" />
              <div className="min-w-0 flex-1 whitespace-nowrap text-md font-semibold tracking-tight text-foreground">{branding.appName}</div>
              {!isMobile && (
                <button
                  onClick={toggleCollapsed}
                  title="Collapse sidebar"
                  aria-label="Collapse sidebar"
                  className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <PanelLeft size={18} strokeWidth={2} />
                </button>
              )}
            </>
          )}
        </div>

        {/* ── Nav ─────────────────────────────────────────────────────────── */}
        <div className="flex flex-1 flex-col overflow-hidden">

        {/* Scrollable agents section */}
        <div className="flex-1 overflow-y-auto px-3 pb-1 pt-3">
          <NavItem href="/" active={pathname === '/'} collapsed={collapsed} icon={<LayoutDashboard size={16} strokeWidth={1.75} />}>Dashboard</NavItem>

          {role !== 'viewer' && (
            <NavItem href="/activity" active={pathname === '/activity' || pathname.startsWith('/activity/')} collapsed={collapsed} icon={<ActivityIcon size={16} strokeWidth={1.75} />} badge={activeTaskCount > 0 ? activeTaskCount : undefined}>Activity</NavItem>
          )}

          {role !== 'viewer' && (
            <NavItem href="/observability" active={pathname.startsWith('/observability')} collapsed={collapsed} icon={<LineChart size={16} strokeWidth={1.75} />}>Observability</NavItem>
          )}

          {!collapsed && (
            <div className="px-2.5 pb-1.5 pt-4 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">Agents</div>
          )}
          {collapsed && <div className="mx-1 my-2.5 h-px bg-border" />}

          {agents.length === 0 && !collapsed && (
            <div className="px-2.5 py-1.5 text-xs italic text-muted-foreground/80">No agents yet</div>
          )}

          {agents.map(agent => {
            const isActive = pathname === `/agents/${agent.slug}`;
            const displayStatus = agent.liveStatus ?? agent.status;
            const dot = STATUS_DOT[displayStatus] ?? 'var(--border-2)';
            return (
              <Link
                key={agent.id}
                href={`/agents/${agent.slug}`}
                title={agent.name}
                className={cn(
                  'mb-0.5 flex items-center gap-2.5 rounded-md no-underline transition-colors',
                  collapsed ? 'justify-center py-1.5' : 'justify-start px-3 py-2',
                  isActive ? 'bg-secondary' : 'hover:bg-secondary',
                )}
              >
                <div className="relative shrink-0">
                  <div className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md text-2xs font-semibold',
                    agent.isBoss ? 'bg-primary text-primary-foreground' : 'border border-border bg-secondary text-foreground',
                  )}>{agent.name.charAt(0).toUpperCase()}</div>
                  <span
                    className={cn('absolute -bottom-px -right-px h-2 w-2 rounded-full border-2 border-card', displayStatus === 'running' && 'status-running')}
                    style={{ background: dot }}
                  />
                </div>
                {!collapsed && (
                  <div className="min-w-0 flex-1">
                    <div className={cn('flex items-center gap-1.5 truncate text-sm text-foreground', isActive ? 'font-semibold' : 'font-normal')}>
                      {agent.name}
                      {agent.isBoss && (
                        <span
                          className="shrink-0 rounded-sm px-1 py-px text-[9px] font-semibold uppercase tracking-[0.04em] text-amber"
                          style={{ background: 'color-mix(in srgb, var(--amber) 12%, transparent)' }}
                        >BOSS</span>
                      )}
                    </div>
                  </div>
                )}
              </Link>
            );
          })}

          {canEdit && (
            <Link
              href="/agents/new"
              title="Add agent"
              className={cn(
                'mt-1 flex items-center gap-2 rounded-md text-sm text-muted-foreground no-underline transition-colors hover:bg-secondary hover:text-foreground',
                collapsed ? 'justify-center py-1.5' : 'justify-start px-3 py-2',
              )}
            >
              <Plus size={16} strokeWidth={1.75} className="shrink-0" />
              {!collapsed && 'Add agent'}
            </Link>
          )}

        </div>

        {/* Fixed bottom nav — always visible */}
        <div className="shrink-0 border-t border-border px-3 py-2">

          {!collapsed && (
            <div className="flex items-center justify-between px-1 pb-1 pl-2.5">
              <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">Workspace</span>
              <WhatsNew />
            </div>
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
        <div ref={profileRef} className={cn('relative border-t border-border', collapsed ? 'px-2 py-3' : 'p-3')}>
          {/* Profile row — click to toggle popup */}
          <button
            onClick={() => setProfileOpen(p => !p)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md transition-colors',
              collapsed ? 'justify-center py-1' : 'justify-start px-2.5 py-2',
              profileOpen ? 'bg-secondary' : 'hover:bg-secondary',
            )}
          >
            <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {(username || '?').charAt(0).toUpperCase()}
            </div>
            {!collapsed && (
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium text-foreground">{username}</div>
                <div className="text-2xs capitalize text-muted-foreground/80">{role}</div>
              </div>
            )}
            {!collapsed && (
              <ChevronDown size={13} className={cn('shrink-0 text-muted-foreground/80 transition-transform', profileOpen && 'rotate-180')} />
            )}
          </button>

          {/* Popup menu */}
          {profileOpen && (
            <div
              className={cn(
                'absolute z-[60] overflow-hidden rounded-lg border border-border bg-card shadow-lg',
                collapsed ? 'bottom-[60px] left-2 right-2 min-w-[160px]' : 'bottom-16 left-3 right-3',
              )}
            >
              {collapsed && (
                <div className="border-b border-border px-3.5 py-2.5">
                  <div className="text-sm font-medium text-foreground">{username}</div>
                  <div className="text-2xs capitalize text-muted-foreground/80">{role}</div>
                </div>
              )}
              <a
                href="https://slackhive.mintlify.app"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setProfileOpen(false)}
                className="flex w-full items-center gap-2 border-b border-border px-3.5 py-2.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-secondary"
              >
                <FileText size={15} strokeWidth={1.75} className="shrink-0" />
                <span className="flex-1">Documentation</span>
                <ExternalLink size={12} className="shrink-0 text-muted-foreground/70" />
              </a>
              <button
                onClick={toggleTheme}
                className="flex w-full items-center gap-2 border-b border-border px-3.5 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary"
              >
                {theme === 'light' ? <Moon size={15} strokeWidth={1.75} /> : <Sun size={15} strokeWidth={1.75} />}
                {theme === 'light' ? 'Dark mode' : 'Light mode'}
              </button>
              <button
                onClick={() => { setProfileOpen(false); logout(); }}
                className="flex w-full items-center gap-2 px-3.5 py-2.5 text-sm text-red transition-colors hover:bg-[var(--red-soft-bg)]"
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
  const className = cn(
    'relative flex w-full items-center gap-2.5 rounded-md text-sm no-underline transition-colors',
    collapsed ? 'justify-center py-2' : 'justify-start px-2.5 py-2',
    active ? 'bg-secondary font-semibold text-foreground' : 'font-normal text-muted-foreground hover:bg-secondary hover:text-foreground',
  );
  const iconNode = icon && (
    <span className="relative shrink-0">
      {icon}
      {collapsed && badge !== undefined && badge > 0 && (
        <span className="status-running absolute -right-1 -top-0.5 h-2 w-2 rounded-full border-2 border-card bg-blue" />
      )}
    </span>
  );
  const content = (
    <>
      {iconNode}
      {!collapsed && <span className="flex-1 text-left">{children}</span>}
      {!collapsed && badge !== undefined && badge > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <span className="status-running h-[7px] w-[7px] rounded-full bg-blue" />
          <span className="text-2xs font-semibold text-blue">{badge}</span>
        </span>
      )}
    </>
  );

  if (onClick) {
    return <button onClick={onClick} title={collapsed ? String(children) : undefined} className={className}>{content}</button>;
  }
  return <Link href={href || '/'} title={collapsed ? String(children) : undefined} className={className}>{content}</Link>;
}
