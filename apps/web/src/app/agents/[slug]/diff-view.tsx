'use client';

/**
 * @fileoverview GitHub-style file-diff rendering for the snapshot History tab.
 *
 * Renders a "Files changed" list — summary bar, collapsible per-file cards
 * with status chips, +N/−M counts, and hunked unified diffs with a 2-column
 * line-number gutter. Scoped to presentation; the diff math lives in
 * `@/lib/diff`.
 *
 * @module web/app/agents/[slug]/diff-view
 */

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { lineDiff, hunks, diffStats, type DiffHunk } from '@/lib/diff';
import { Button } from '@/components/ui/button';

/** One file entry in a snapshot comparison. */
export interface FileChange {
  /** Display path, e.g. "CLAUDE.md" or "00-core/workflow.md". */
  path: string;
  status: 'added' | 'removed' | 'modified';
  /** Previous content. Empty string for `added`. */
  oldText: string;
  /** New content. Empty string for `removed`. */
  newText: string;
}

// Color tokens used throughout. Kept as constants so the six rows we render
// per line share literals the bundler can hoist.
const ADD_BG    = 'rgba(16,185,129,0.12)';
const ADD_COLOR = 'var(--green)';
const DEL_BG    = 'var(--red-soft-bg)';
const DEL_COLOR = 'var(--red)';
const MOD_BG    = 'rgba(234,179,8,0.15)';
const MOD_COLOR = 'rgba(234,179,8,0.9)';

/**
 * Top-level list. Renders a summary header plus one collapsible card per file.
 * No-op when `files` is empty — callers are expected to handle the empty
 * state themselves, since "no file diffs" may still need to show other
 * changesets (tools, MCPs, channels) in the same screen.
 */
export function FilesChanged({ files }: { files: FileChange[] }) {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(files.map(f => f.path)));

  // Totals for the summary bar. Computed on every render but the cost is
  // negligible vs the hunk rendering below.
  const totals = useMemo(() => {
    let added = 0, removed = 0;
    for (const f of files) {
      if (f.status === 'added') added += f.newText ? f.newText.split('\n').length : 0;
      else if (f.status === 'removed') removed += f.oldText ? f.oldText.split('\n').length : 0;
      else {
        const s = diffStats(lineDiff(f.oldText, f.newText));
        added += s.added; removed += s.removed;
      }
    }
    return { added, removed };
  }, [files]);

  if (files.length === 0) return null;

  const allOpen = openIds.size === files.length;
  const toggleAll = () => {
    if (allOpen) setOpenIds(new Set());
    else setOpenIds(new Set(files.map(f => f.path)));
  };
  const toggleOne = (path: string) => {
    setOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-card border border-border rounded-lg shadow-sm">
        <span className="text-sm text-foreground font-semibold">
          {files.length} file{files.length === 1 ? '' : 's'} will change
        </span>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-xs font-mono text-green">+{totals.added}</span>
        <span className="text-xs font-mono text-red">−{totals.removed}</span>
        <Button
          onClick={toggleAll}
          variant="outline"
          size="sm"
          className="ml-auto h-auto px-2.5 py-[3px] text-xs text-muted-foreground font-normal"
        >{allOpen ? 'Collapse all' : 'Expand all'}</Button>
      </div>

      {files.map(f => (
        <FileDiff
          key={f.path}
          file={f}
          open={openIds.has(f.path)}
          onToggle={() => toggleOne(f.path)}
        />
      ))}
    </div>
  );
}

/** One file card: clickable header + collapsible hunked body. */
function FileDiff({ file, open, onToggle }: { file: FileChange; open: boolean; onToggle: () => void }) {
  const { added, removed, computedHunks } = useMemo(() => {
    if (file.status === 'added') {
      const lines = file.newText.split('\n');
      return { added: lines.length, removed: 0, computedHunks: [] as DiffHunk[] };
    }
    if (file.status === 'removed') {
      const lines = file.oldText.split('\n');
      return { added: 0, removed: lines.length, computedHunks: [] as DiffHunk[] };
    }
    const raw = lineDiff(file.oldText, file.newText);
    const s = diffStats(raw);
    return { added: s.added, removed: s.removed, computedHunks: hunks(raw, 3) };
  }, [file]);

  const chip = STATUS_CHIP[file.status];

  return (
    <div className="bg-card border border-border rounded-lg shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 bg-transparent border-none cursor-pointer text-left text-foreground"
      >
        {open ? <ChevronDown size={14} className="text-muted-foreground" />
              : <ChevronRight size={14} className="text-muted-foreground" />}
        <FileText size={13} className="text-muted-foreground" />
        <span
          className="text-2xs font-bold px-1.5 py-px rounded-sm"
          style={{ background: chip.bg, color: chip.color }}
        >{chip.label}</span>
        <span className="text-sm font-mono text-foreground flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{file.path}</span>
        <span className="text-xs font-mono text-green">+{added}</span>
        <span className="text-xs font-mono text-red">−{removed}</span>
      </button>

      {open && (
        <div className="border-t border-border bg-muted">
          {file.status === 'added'   && <WholeFileBlock text={file.newText} kind="add" />}
          {file.status === 'removed' && <WholeFileBlock text={file.oldText} kind="del" />}
          {file.status === 'modified' && (
            computedHunks.length === 0
              ? <EmptyDiff />
              : <HunksView hunks={computedHunks} />
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_CHIP: Record<FileChange['status'], { label: string; bg: string; color: string }> = {
  added:    { label: 'will be added',   bg: ADD_BG, color: ADD_COLOR },
  removed:  { label: 'will be removed', bg: DEL_BG, color: DEL_COLOR },
  modified: { label: 'will change',     bg: MOD_BG, color: MOD_COLOR },
};

function EmptyDiff() {
  return (
    <div className="px-4 py-3.5 text-sm text-muted-foreground text-center">No differences</div>
  );
}

/** All-green or all-red full file view, used for added/removed files. */
function WholeFileBlock({ text, kind }: { text: string; kind: 'add' | 'del' }) {
  const lines = text.split('\n');
  const bg = kind === 'add' ? ADD_BG : DEL_BG;
  const color = kind === 'add' ? ADD_COLOR : DEL_COLOR;
  const prefix = kind === 'add' ? '+' : '−';
  const width = String(lines.length).length;
  return (
    <div className="text-xs font-mono leading-relaxed max-h-[480px] overflow-auto">
      {lines.map((ln, i) => (
        <div key={i} className="flex" style={{ background: bg, color }}>
          <Gutter n={kind === 'add' ? null : i + 1} width={width} />
          <Gutter n={kind === 'add' ? i + 1 : null} width={width} />
          <span className="w-[18px] flex-shrink-0 text-center select-none opacity-70">{prefix}</span>
          <span className="flex-1 whitespace-pre-wrap break-words pr-3">{ln || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/** Render each hunk with its `@@` header, divided by a dashed line. */
function HunksView({ hunks: hs }: { hunks: DiffHunk[] }) {
  const gutterWidth = useMemo(() => {
    let max = 0;
    for (const h of hs) for (const l of h.lines) {
      if (l.oldNo !== null) max = Math.max(max, String(l.oldNo).length);
      if (l.newNo !== null) max = Math.max(max, String(l.newNo).length);
    }
    return Math.max(2, max);
  }, [hs]);

  return (
    <div className="text-xs font-mono leading-relaxed max-h-[480px] overflow-auto">
      {hs.map((h, hi) => (
        <React.Fragment key={hi}>
          {hi > 0 && <div className="border-t border-dashed border-border" />}
          <div
            className="px-3 py-1 text-2xs text-muted-foreground border-b border-border"
            style={{ background: 'rgba(99,102,241,0.06)' }}
          >
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {h.lines.map((l, li) => {
            const bg = l.type === 'add' ? ADD_BG : l.type === 'remove' ? DEL_BG : 'transparent';
            const color = l.type === 'add' ? ADD_COLOR : l.type === 'remove' ? DEL_COLOR : 'var(--text)';
            const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '−' : ' ';
            return (
              <div key={li} className="flex" style={{ background: bg, color }}>
                <Gutter n={l.oldNo} width={gutterWidth} />
                <Gutter n={l.newNo} width={gutterWidth} />
                <span className="w-[18px] flex-shrink-0 text-center select-none opacity-70">{prefix}</span>
                <span className="flex-1 whitespace-pre-wrap break-words pr-3">
                  {l.line || ' '}
                </span>
              </div>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

/** Right-aligned fixed-width line-number cell. `null` renders as blank. */
function Gutter({ n, width }: { n: number | null; width: number }) {
  return (
    <span
      className="flex-shrink-0 text-right pr-2 text-muted-foreground select-none border-r border-border"
      style={{ width: `${width + 2}ch`, opacity: n === null ? 0.3 : 1 }}
    >{n ?? ''}</span>
  );
}
