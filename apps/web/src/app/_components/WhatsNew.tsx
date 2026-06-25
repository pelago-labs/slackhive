'use client';

/**
 * @fileoverview "What's New" — a subtle bell (rendered in the sidebar header) with
 * an unread dot that opens a dropdown of recent big features (title + summary +
 * date). Entries are curated in `src/data/whats-new.json` (one per significant
 * feature merged to master). "Unread" is tracked in localStorage by the newest
 * entry's date. The panel is portaled with fixed positioning so the sidebar's
 * overflow can't clip it.
 *
 * @module web/app/_components/WhatsNew
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X } from 'lucide-react';
import entriesData from '@/data/whats-new.json';
import { cn } from '@/lib/utils';

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

/** Place the panel below the bell, flipping above when there's more room there,
 *  and cap its height to the available space so it never runs off-screen. */
function panelPlacement(box: DOMRect): React.CSSProperties {
  const MARGIN = 16;
  const left = Math.round(Math.min(Math.max(8, box.left), window.innerWidth - 348));
  const below = window.innerHeight - box.bottom - MARGIN;
  const above = box.top - MARGIN;
  const openUp = below < 300 && above > below;
  const maxHeight = Math.round(Math.max(180, Math.min(460, openUp ? above : below)));
  return openUp
    ? { bottom: Math.round(window.innerHeight - box.top + 8), left, maxHeight }
    : { top: Math.round(box.bottom + 8), left, maxHeight };
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
      {/* Subtle inline bell (sits in the sidebar header); dot signals updates. */}
      <button
        ref={btnRef}
        onClick={openPanel}
        title="What's New"
        aria-label="What's New"
        className={cn(
          'relative flex h-7 w-7 items-center justify-center rounded-md p-0 transition-colors',
          open
            ? 'bg-secondary text-foreground'
            : 'bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
        )}
      >
        <Bell size={16} strokeWidth={1.75} />
        {unread > 0 && (
          <span className="absolute right-1 top-1 h-[7px] w-[7px] rounded-full border-[1.5px] border-card bg-blue" />
        )}
      </button>

      {open && box && createPortal(
        <>
          <div onClick={() => setBox(null)} className="fixed inset-0 z-[1000]" />
          <div
            className="fixed z-[1001] w-[340px] overflow-y-auto rounded-lg border border-border bg-card p-0 shadow-lg"
            style={{
              // Open below the bell, but flip above when there isn't room (the bell
              // sits low in the sidebar, so the panel would otherwise run off-screen).
              ...panelPlacement(box),
            }}
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-border bg-card px-3.5 py-3">
              <div className="inline-flex items-center gap-2 text-sm font-bold text-foreground">
                <Bell size={14} /> What&apos;s New
              </div>
              <button onClick={() => setBox(null)} className="inline-flex p-0.5 text-muted-foreground" aria-label="Close">
                <X size={15} />
              </button>
            </div>
            <div className="py-1.5">
              {ENTRIES.length === 0 && (
                <div className="p-6 text-center text-sm text-muted-foreground">Nothing new yet.</div>
              )}
              {ENTRIES.map(e => (
                <div key={e.id} className="border-b border-border px-3.5 py-3">
                  <div className="flex items-baseline justify-between gap-2.5">
                    <span className="text-sm font-semibold text-foreground">{e.title}</span>
                    <span className="shrink-0 whitespace-nowrap text-2xs text-muted-foreground">{fmtDate(e.date)}</span>
                  </div>
                  <div className="mt-1 text-xs leading-normal text-muted-foreground">{e.summary}</div>
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
