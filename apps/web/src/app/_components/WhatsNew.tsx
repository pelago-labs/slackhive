'use client';

/**
 * @fileoverview "What's New" — a fixed top-right bell with an unread badge that
 * opens a dropdown of recent big features (title + summary + date). Entries are
 * curated in `src/data/whats-new.json` (one per significant feature merged to
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

export function WhatsNew(): React.JSX.Element {
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

  return (
    <>
      {/* Fixed top-right floating bell. */}
      <button ref={btnRef} onClick={openPanel} title="What's New" aria-label="What's New" style={{
        position: 'fixed', top: 12, right: 16, zIndex: 47,
        width: 36, height: 36, borderRadius: 9,
        background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', color: open ? 'var(--text)' : 'var(--muted)',
      }}>
        <Bell size={17} strokeWidth={1.75} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px',
            borderRadius: 8, background: '#2563eb', color: '#fff', border: '2px solid var(--surface)',
            fontSize: 10, fontWeight: 700, lineHeight: '12px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{unread}</span>
        )}
      </button>

      {open && box && createPortal(
        <>
          <div onClick={() => setBox(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
          <div style={{
            position: 'fixed', zIndex: 1001,
            // Anchor below the bell, right-aligned, clamped to the viewport.
            top: Math.round(box.bottom + 8),
            left: Math.round(Math.max(8, box.right - 340)),
            width: 340, maxHeight: 'min(440px, calc(100vh - 80px))', overflowY: 'auto',
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
