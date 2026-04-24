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
import { Activity as ActivityIcon, BarChart3 } from 'lucide-react';

interface Tab {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const TABS: Tab[] = [
  { href: '/activity',       label: 'Tasks', icon: <ActivityIcon size={13} /> },
  { href: '/activity/usage', label: 'Usage', icon: <BarChart3    size={13} /> },
];

export function TabSwitcher(): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();

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
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: 3, background: 'var(--surface-2)',
        border: '1px solid var(--border)', borderRadius: 8,
        marginBottom: 16,
      }}
    >
      {TABS.map(tab => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            role="tab"
            aria-selected={active}
            href={`${tab.href}${query}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 12px', borderRadius: 6,
              fontSize: 12, fontWeight: 500,
              color: active ? 'var(--text)' : 'var(--muted)',
              background: active ? 'var(--surface)' : 'transparent',
              boxShadow: active ? 'var(--shadow-sm)' : 'none',
              textDecoration: 'none',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {tab.icon}
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
