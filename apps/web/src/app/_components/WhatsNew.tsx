'use client';

/**
 * @fileoverview "What's New" — a sidebar bell with an unread badge that opens a
 * dropdown of recent big features (title + summary + date). Entries are curated
 * in `src/data/whats-new.json` (one entry per significant feature merged to
 * master). "Unread" is tracked in localStorage by the newest entry's date.
 *
 * @module web/app/_components/WhatsNew
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X } from 'lucide-react';
import entriesData from '@/data/whats-new.json';

interface Entry { id: string; date: string; title: string; summary: string }

// Newest first; dates are YYYY-MM-DD so lexicographic sort is chronological.
const ENTRIES: Entry[] = (entriesData as Entry[]).slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
const NEWEST = ENTRIES[0]?.date ?? '';
const LS_KEY = 'slackhive:whatsnew:lastSeen';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return y && m && day ? `${MONTHS[m - 1]} ${day}, ${y}` : d;
}

export function WhatsNew({ collapsed }: { collapsed?: boolean }): React.JSX.Element {
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [box, setBox] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setLastSeen(localStorage.getItem(LS_KEY)); setReady(true); }, []);

  // Until localStorage is read, assume seen (avoid a flash of the unread badge).
  const unread = !ready ? 0 : lastSeen === null ? ENTRIES.length : ENTRIES.filter(e => e.date > lastSeen).length;
  const open = box !== null;

  const openPanel = () => {
    setBox(btnRef.current?.getBoundingClientRect() ?? null);
    if (NEWEST) { localStorage.setItem(LS_KEY, NEWEST); setLastSeen(NEWEST); } // mark all seen
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setBox(null);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [open]);

  const navStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: collapsed ? '8px 0' : '8px 10px',
    justifyContent: collapsed ? 'center' : 'flex-start',
    borderRadius: 8, border: 'none', background: open ? 'var(--surface-2)' : 'transparent',
    color: open ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontWeight: open ? 600 : 400,
    transition: 'background 0.12s, color 0.12s', cursor: 'pointer', width: '100%',
    fontFamily: 'var(--font-sans)', position: 'relative',
  };
  const hover = (e: React.MouseEvent) => { if (!open) { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; } };
  const leave = (e: React.MouseEvent) => { if (!open) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; } };

  return (
    <>
      <button ref={btnRef} onClick={openPanel} title={collapsed ? "What's New" : undefined} style={navStyle} onMouseEnter={hover} onMouseLeave={leave}>
        <span style={{ flexShrink: 0, position: 'relative' }}>
          <Bell size={16} strokeWidth={1.75} />
          {collapsed && unread > 0 && (
            <span style={{ position: 'absolute', top: -2, right: -4, width: 8, height: 8, borderRadius: '50%', background: '#2563eb', border: '2px solid var(--surface)' }} />
          )}
        </span>
        {!collapsed && <span style={{ flex: 1, textAlign: 'left' }}>What&apos;s New</span>}
        {!collapsed && unread > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#2563eb' }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: '#2563eb' }}>{unread}</span>
          </span>
        )}
      </button>

      {open && box && createPortal(
        <>
          <div onClick={() => setBox(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
          <div style={{
            position: 'fixed', zIndex: 1001,
            left: Math.round(box.right + 8),
            top: Math.min(Math.round(box.top), Math.max(8, window.innerHeight - 460)),
            width: 340, maxHeight: 440, overflowY: 'auto',
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
            boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)' }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                <Bell size={14} /> What&apos;s New
              </div>
              <button onClick={() => setBox(null)} style={{ display: 'inline-flex', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--subtle)', padding: 2 }} aria-label="Close">
                <X size={15} />
              </button>
            </div>
            <div style={{ padding: '6px 0' }}>
              {ENTRIES.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>Nothing new yet.</div>
              )}
              {ENTRIES.map(e => (
                <div key={e.id} style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{e.title}</span>
                    <span style={{ fontSize: 11, color: 'var(--subtle)', flexShrink: 0, whiteSpace: 'nowrap' }}>{fmtDate(e.date)}</span>
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted)' }}>{e.summary}</div>
                </div>
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
