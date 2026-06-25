'use client';

/**
 * @fileoverview Agent + time-window filter row shared between the Activity
 * kanban and the Usage dashboard. State lives in the parent; this component
 * just renders the two selects and raises change events.
 *
 * @module web/app/activity/_components/FilterRow
 */

import React, { useState } from 'react';
import { Filter as FilterIcon, Calendar as CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type WindowKey = '1h' | '5h' | '24h' | '7d' | '30d' | '90d' | 'custom';

interface AgentOption {
  id: string;
  name: string;
}

export const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: '1h',     label: 'Last 1 hour' },
  { key: '5h',     label: 'Last 5 hours' },
  { key: '24h',    label: 'Last 24 hours' },
  { key: '7d',     label: 'Last 7 days' },
  { key: '30d',    label: 'Last 30 days' },
  { key: '90d',    label: 'Last 90 days' },
  { key: 'custom', label: 'Custom range…' },
];

/** Parse a `WindowKey` from a URL param, accepting `custom`. */
export function parseWindowKey(w: string | null | undefined): WindowKey {
  return w === '1h' || w === '5h' || w === '24h' || w === '7d' || w === '30d' || w === '90d' || w === 'custom' ? w : '24h';
}

/** Time query params for an activity fetch — a preset `window`, or `from`/`to`
 * for a custom range. Shared by every activity page to avoid drift.
 *
 * For a custom range the picked `YYYY-MM-DD` days are resolved to absolute UTC
 * instants HERE, in the browser, where the user's timezone is known — so the
 * server stores them directly instead of reparsing a bare date in the host's
 * timezone (which would shift the range when host and browser timezones differ). */
export function timeParams(windowKey: WindowKey, from: string, to: string): Record<string, string> {
  if (windowKey === 'custom' && from && to) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const start = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
    const end = new Date(ty, tm - 1, td, 23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  return { window: windowKey };
}

/** Local `YYYY-MM-DD` for a `<input type="date">` value. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const todayStr = () => localDate(Date.now());
const daysAgoStr = (n: number) => localDate(Date.now() - n * 86_400_000);

const selectClass =
  'text-sm font-medium text-foreground bg-card border border-border rounded-md px-3 py-1.5 cursor-pointer shadow-sm';

export function FilterRow(props: {
  agents: AgentOption[];
  agentFilter: string;
  windowKey: WindowKey;
  onAgentChange: (id: string) => void;
  onWindowChange: (w: WindowKey) => void;
  /** Custom date range (YYYY-MM-DD); required to enable the "Custom range" option. */
  from?: string;
  to?: string;
  onRangeChange?: (from: string, to: string) => void;
}): React.JSX.Element {
  const { agents, agentFilter, windowKey, onAgentChange, onWindowChange, from, to, onRangeChange } = props;
  return (
    <div className="flex items-center gap-2 mb-[18px] flex-wrap">
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground pl-0 pr-2.5 py-1.5">
        <FilterIcon size={14} /> Filter
      </span>
      <select
        value={agentFilter}
        onChange={e => onAgentChange(e.target.value)}
        className={selectClass}
      >
        <option value="">All agents</option>
        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select
        value={windowKey}
        onChange={e => {
          const w = e.target.value as WindowKey;
          // Seed sensible defaults the first time Custom is picked.
          if (w === 'custom' && onRangeChange && (!from || !to)) onRangeChange(from || daysAgoStr(7), to || todayStr());
          onWindowChange(w);
        }}
        className={selectClass}
      >
        {WINDOWS.filter(w => w.key !== 'custom' || onRangeChange).map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
      </select>
      {windowKey === 'custom' && onRangeChange && (
        <RangePicker from={from ?? ''} to={to ?? ''} onApply={onRangeChange} />
      )}
    </div>
  );
}

/** `YYYY-MM-DD` → `MMM D` for the button label. */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtShort(d: string): string {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${MONTHS_SHORT[Number(m) - 1]} ${Number(day)}`;
}
const pad2 = (n: number) => String(n).padStart(2, '0');

/** A single button that opens ONE calendar to click a start then an end date. */
function RangePicker({ from, to, onApply }: { from: string; to: string; onApply: (f: string, t: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const init = (from || todayStr()).split('-');
  const [view, setView] = useState<{ y: number; m: number }>({ y: Number(init[0]), m: Number(init[1]) - 1 });
  const today = todayStr();

  const openPanel = () => {
    setStart(from); setEnd(to);
    const i = (from || todayStr()).split('-');
    setView({ y: Number(i[0]), m: Number(i[1]) - 1 });
    setOpen(o => !o);
  };

  const pick = (ds: string) => {
    if (!start || (start && end)) { setStart(ds); setEnd(''); }
    else if (ds < start) { setStart(ds); }
    else { setEnd(ds); }
  };

  const shiftMonth = (delta: number) => {
    setView(v => {
      const m = v.m + delta;
      return { y: v.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
    });
  };

  // Build the month grid.
  const firstWeekday = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${view.y}-${pad2(view.m + 1)}-${pad2(d)}`);

  return (
    <div className="relative">
      <button onClick={openPanel} className={cn(selectClass, 'inline-flex items-center gap-1.5')}>
        <CalendarIcon size={13} className="text-muted-foreground" />
        {from && to ? `${fmtShort(from)} – ${fmtShort(to)}` : 'Pick range'}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div className="absolute top-[calc(100%+6px)] left-0 z-[41] bg-card border border-border rounded-lg shadow-md p-3 w-[252px]">
            {/* month header */}
            <div className="flex items-center justify-between mb-2">
              <button onClick={() => shiftMonth(-1)} className={navBtnClass}>‹</button>
              <span className="text-sm font-semibold text-foreground">{MONTHS[view.m]} {view.y}</span>
              <button onClick={() => shiftMonth(1)} className={navBtnClass}>›</button>
            </div>
            {/* weekday row */}
            <div className="grid grid-cols-7 gap-0.5 mb-0.5">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
                <div key={i} className="text-center text-[9px] font-semibold text-muted-foreground py-0.5">{w}</div>
              ))}
            </div>
            {/* day grid */}
            <div className="grid grid-cols-7 gap-0.5">
              {cells.map((ds, i) => {
                if (!ds) return <div key={i} />;
                const future = ds > today;
                const isStart = ds === start, isEnd = ds === end;
                const endpoint = isStart || isEnd;
                const inRange = !!start && !!end && ds > start && ds < end;
                return (
                  <button
                    key={i}
                    disabled={future}
                    onClick={() => pick(ds)}
                    className={cn(
                      'h-7 border-0 rounded-md text-xs',
                      future ? 'cursor-default opacity-40' : 'cursor-pointer',
                      endpoint
                        ? 'bg-primary text-primary-foreground font-semibold'
                        : cn(
                            'font-normal',
                            inRange ? 'bg-secondary' : 'bg-transparent',
                            future ? 'text-muted-foreground' : 'text-foreground',
                          ),
                    )}
                  >
                    {Number(ds.slice(8))}
                  </button>
                );
              })}
            </div>
            {/* footer */}
            <div className="flex items-center justify-between mt-2.5 gap-2">
              <span className="text-2xs text-muted-foreground">
                {start ? (end ? `${fmtShort(start)} – ${fmtShort(end)}` : `${fmtShort(start)} – …`) : 'Select a range'}
              </span>
              <button
                disabled={!start || !end}
                onClick={() => { onApply(start, end); setOpen(false); }}
                className={cn(
                  selectClass,
                  'px-3.5 py-1 bg-primary text-primary-foreground border-0 font-semibold',
                  (!start || !end) ? 'opacity-50 cursor-default' : 'cursor-pointer',
                )}
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const navBtnClass =
  'w-[26px] h-[26px] rounded-md border border-border bg-secondary text-foreground cursor-pointer text-base leading-none';
