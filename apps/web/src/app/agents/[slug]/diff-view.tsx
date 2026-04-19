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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-card)',
      }}>
        <span style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 600 }}>
          {files.length} file{files.length === 1 ? '' : 's'} will change
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>·</span>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: ADD_COLOR }}>+{totals.added}</span>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: DEL_COLOR }}>−{totals.removed}</span>
        <button
          onClick={toggleAll}
          style={{
            marginLeft: 'auto', fontSize: 12, color: 'var(--muted)',
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 6, padding: '3px 9px', cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >{allOpen ? 'Collapse all' : 'Expand all'}</button>
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
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-card)',
      overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left', color: 'var(--text)',
        }}
      >
        {open ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} />
              : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}
        <FileText size={13} style={{ color: 'var(--muted)' }} />
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
          background: chip.bg, color: chip.color,
        }}>{chip.label}</span>
        <span style={{
          fontSize: 12.5, fontFamily: 'var(--font-mono)',
          color: 'var(--text)', flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{file.path}</span>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: ADD_COLOR }}>+{added}</span>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: DEL_COLOR }}>−{removed}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
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
    <div style={{
      padding: '14px 18px', fontSize: 12.5, color: 'var(--subtle)', textAlign: 'center',
    }}>No differences</div>
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
    <div style={{
      fontSize: 12, fontFamily: 'var(--font-mono)', lineHeight: 1.6,
      maxHeight: 480, overflow: 'auto',
    }}>
      {lines.map((ln, i) => (
        <div key={i} style={{ display: 'flex', background: bg, color }}>
          <Gutter n={kind === 'add' ? null : i + 1} width={width} />
          <Gutter n={kind === 'add' ? i + 1 : null} width={width} />
          <span style={{ width: 18, flexShrink: 0, textAlign: 'center', userSelect: 'none', opacity: 0.7 }}>{prefix}</span>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingRight: 12 }}>{ln || ' '}</span>
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
    <div style={{
      fontSize: 12, fontFamily: 'var(--font-mono)', lineHeight: 1.6,
      maxHeight: 480, overflow: 'auto',
    }}>
      {hs.map((h, hi) => (
        <React.Fragment key={hi}>
          {hi > 0 && <div style={{ borderTop: '1px dashed var(--border)' }} />}
          <div style={{
            padding: '4px 12px', fontSize: 11.5, color: 'var(--muted)',
            background: 'rgba(99,102,241,0.06)',
            borderBottom: '1px solid var(--border)',
          }}>
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {h.lines.map((l, li) => {
            const bg = l.type === 'add' ? ADD_BG : l.type === 'remove' ? DEL_BG : 'transparent';
            const color = l.type === 'add' ? ADD_COLOR : l.type === 'remove' ? DEL_COLOR : 'var(--text)';
            const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '−' : ' ';
            return (
              <div key={li} style={{ display: 'flex', background: bg, color }}>
                <Gutter n={l.oldNo} width={gutterWidth} />
                <Gutter n={l.newNo} width={gutterWidth} />
                <span style={{ width: 18, flexShrink: 0, textAlign: 'center', userSelect: 'none', opacity: 0.7 }}>{prefix}</span>
                <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingRight: 12 }}>
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
    <span style={{
      width: `${width + 2}ch`, flexShrink: 0, textAlign: 'right',
      paddingRight: 8, color: 'var(--subtle)', userSelect: 'none',
      borderRight: '1px solid var(--border)', opacity: n === null ? 0.3 : 1,
    }}>{n ?? ''}</span>
  );
}
