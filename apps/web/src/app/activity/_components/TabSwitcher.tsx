'use client';

/**
 * @fileoverview Two-tab segmented control between the Activity kanban
 * (`/activity`) and the Usage dashboard (`/activity/usage`). Preserves the
 * `agent` and `window` query params when switching tabs.
 *
 * @module web/app/activity/_components/TabSwitcher
 */

import React from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Activity as ActivityIcon } from 'lucide-react';
import { useAuth, type Role } from '@/lib/auth-context';
import { cn } from '@/lib/utils';

interface Tab {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** Only render this tab when the user's role is in this list. `undefined` = visible to everyone. */
  roles?: Role[];
}

// The consolidated LLMOps view now lives at the top-level "Observability" nav item,
// not as an Activity sub-tab. Only Tasks remains here (the switcher hides itself
// when a single tab is left), but the component stays for future tabs.
const TABS: Tab[] = [
  { href: '/activity', label: 'Tasks', icon: <ActivityIcon size={13} /> },
];

export function TabSwitcher(): React.JSX.Element | null {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { role, loading } = useAuth();

  if (loading) return null;
  const visibleTabs = TABS.filter(t => !t.roles || (role && t.roles.includes(role)));
  if (visibleTabs.length <= 1) return null;

  const query = (() => {
    const qs = new URLSearchParams();
    const agent = searchParams?.get('agent');
    const window_ = searchParams?.get('window');
    if (agent)   qs.set('agent',  agent);
    if (window_) qs.set('window', window_);
    const s = qs.toString();
    return s ? `?${s}` : '';
  })();

  return (
    <div
      role="tablist"
      className="mb-4 inline-flex items-center gap-1 rounded-lg border border-border bg-secondary p-1"
    >
      {visibleTabs.map(tab => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            role="tab"
            aria-selected={active}
            href={`${tab.href}${query}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium no-underline transition-colors',
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground',
            )}
          >
            {tab.icon}
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
