'use client';

/**
 * @fileoverview Notion-style drawer for managing an agent's eval test cases.
 *
 * Two modes inside the drawer:
 *   - List: scrollable table of cases with edit / archive actions
 *   - Form: add a new case or edit an existing one
 *
 * The 5 user-facing check types map to the 3 framework primitives:
 *   - "Reply must contain text"        ↔ substring + must_contain
 *   - "Reply must NOT contain text"    ↔ substring + must_not_contain
 *   - "Agent must call this MCP tool"  ↔ tool_called + must_call
 *   - "Agent must NOT call ..."        ↔ tool_called + must_not_call
 *   - "LLM judges against rubric"      ↔ llm_judge + rubric + groundtruth
 *
 * @module web/app/agents/[slug]/evals-cases-drawer
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  Agent,
  CheckConfig,
  CreateEvalCaseRequest,
  EvalCase,
  McpServer,
  UpdateEvalCaseRequest,
} from '@slackhive/shared';
import { Loader2, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import type { McpTool } from '@slackhive/shared';
import { Portal } from '@/lib/portal';

// ─── UI-facing check kinds ────────────────────────────────────────────────────

type UICheckKind =
  | 'substring_contain'
  | 'substring_not_contain'
  | 'tool_called_must'
  | 'tool_called_must_not'
  | 'llm_judge';

const UI_CHECK_LABEL: Record<UICheckKind, string> = {
  substring_contain: 'Reply must contain text',
  substring_not_contain: 'Reply must NOT contain text',
  tool_called_must: 'Agent must call this MCP tool',
  tool_called_must_not: 'Agent must NOT call this MCP tool',
  llm_judge: 'LLM judges against rubric',
};

function uiKindOf(c: CheckConfig): UICheckKind {
  if (c.primitive === 'substring') {
    return c.must_not_contain && !c.must_contain ? 'substring_not_contain' : 'substring_contain';
  }
  if (c.primitive === 'tool_called') {
    return c.must_not_call && !c.must_call ? 'tool_called_must_not' : 'tool_called_must';
  }
  return 'llm_judge';
}

function emptyCheck(kind: UICheckKind): CheckConfig {
  switch (kind) {
    case 'substring_contain':
      return { primitive: 'substring', target: 'final_reply', must_contain: [] };
    case 'substring_not_contain':
      return { primitive: 'substring', target: 'final_reply', must_not_contain: [] };
    case 'tool_called_must':
      return { primitive: 'tool_called', must_call: [] };
    case 'tool_called_must_not':
      return { primitive: 'tool_called', must_not_call: [] };
    case 'llm_judge':
      return { primitive: 'llm_judge', target: 'final_reply', rubric: '' };
  }
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

interface DrawerProps {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  /** Force-open in "new case" mode rather than the list. */
  startInNew?: boolean;
  /** Called after any successful create / update / delete. */
  onCasesChanged?: () => void;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'edit'; caseId: string };

export function EvalsCasesDrawer({
  agent,
  open,
  onClose,
  startInNew = false,
  onCasesChanged,
}: DrawerProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [mcps, setMcps] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [casesRes, mcpsRes] = await Promise.all([
        fetch(`/api/agents/${agent.id}/evals/cases`),
        fetch(`/api/agents/${agent.id}/mcps`).catch(() => null),
      ]);
      if (casesRes.ok) setCases(await casesRes.json());
      if (mcpsRes?.ok) setMcps(await mcpsRes.json());
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  const handleBulkDelete = useCallback(async () => {
    if (selected.size === 0 || bulkDeleting) return;
    if (
      !confirm(
        `Delete ${selected.size} case${selected.size === 1 ? '' : 's'}? This cannot be undone.`,
      )
    )
      return;
    setBulkDeleting(true);
    try {
      await Promise.all(
        [...selected].map((id) =>
          fetch(`/api/agents/${agent.id}/evals/cases/${id}`, { method: 'DELETE' }),
        ),
      );
      setSelected(new Set());
      await refresh();
      onCasesChanged?.();
    } finally {
      setBulkDeleting(false);
    }
  }, [agent.id, selected, bulkDeleting, refresh, onCasesChanged]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  // Drop selection if cases change underneath us (e.g., after generate or refresh).
  useEffect(() => {
    if (selected.size === 0) return;
    const live = new Set(cases.map((c) => c.id));
    let pruned = false;
    const next = new Set<string>();
    for (const id of selected) {
      if (live.has(id)) next.add(id);
      else pruned = true;
    }
    if (pruned) setSelected(next);
  }, [cases, selected]);


  useEffect(() => {
    if (!open) return;
    setMode(startInNew ? { kind: 'new' } : { kind: 'list' });
    refresh();
  }, [open, startInNew, refresh]);

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) onClose();
    }
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, onClose]);

  if (!open) return null;

  const editingCase =
    mode.kind === 'edit' ? cases.find((c) => c.id === mode.caseId) ?? null : null;

  const title =
    mode.kind === 'list'
      ? 'Manage test cases'
      : mode.kind === 'new'
        ? 'New test case'
        : 'Edit test case';

  return (
    <Portal>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 100,
        }}
      />
      <aside
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 580,
          maxWidth: '92vw',
          background: 'var(--surface)',
          boxShadow: '-12px 0 40px rgba(0,0,0,0.18)',
          zIndex: 101,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 22px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 6,
              lineHeight: 1,
              display: 'inline-flex',
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
          {mode.kind === 'list' && (
            <ListView
              cases={cases}
              loading={loading}
              selected={selected}
              bulkDeleting={bulkDeleting}
              onToggleSelected={toggleSelected}
              onSelectAll={() => setSelected(new Set(cases.map((c) => c.id)))}
              onClearSelection={clearSelection}
              onBulkDelete={handleBulkDelete}
              onNew={() => setMode({ kind: 'new' })}
              onEdit={(id) => setMode({ kind: 'edit', caseId: id })}
              onDelete={async (id) => {
                if (!confirm('Delete this case? This cannot be undone.')) return;
                await fetch(`/api/agents/${agent.id}/evals/cases/${id}`, { method: 'DELETE' });
                await refresh();
                onCasesChanged?.();
              }}
            />
          )}
          {(mode.kind === 'new' || (mode.kind === 'edit' && editingCase)) && (
            <FormView
              agent={agent}
              mcps={mcps}
              existing={mode.kind === 'edit' ? editingCase! : null}
              onCancel={() => setMode({ kind: 'list' })}
              onAutoFilled={async () => {
                // Auto-fill persisted a proposed case server-side. Refresh
                // the list so it shows up even if the user navigates away
                // before promoting it.
                await refresh();
                onCasesChanged?.();
              }}
              onSaved={async () => {
                await refresh();
                onCasesChanged?.();
                setMode({ kind: 'list' });
              }}
              onArchive={async (id) => {
                if (!confirm('Delete this case? This cannot be undone.')) return;
                await fetch(`/api/agents/${agent.id}/evals/cases/${id}`, { method: 'DELETE' });
                await refresh();
                onCasesChanged?.();
                setMode({ kind: 'list' });
              }}
            />
          )}
        </div>
      </aside>
    </Portal>
  );
}

// ─── List view ────────────────────────────────────────────────────────────────

function ListView({
  cases,
  loading,
  selected,
  bulkDeleting,
  onToggleSelected,
  onSelectAll,
  onClearSelection,
  onBulkDelete,
  onNew,
  onEdit,
  onDelete,
}: {
  cases: EvalCase[];
  loading: boolean;
  selected: Set<string>;
  bulkDeleting: boolean;
  onToggleSelected: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkDelete: () => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const approvedCount = cases.filter((c) => c.status === 'approved').length;
  const proposedCount = cases.length - approvedCount;
  const allSelected = cases.length > 0 && selected.size === cases.length;
  const inSelectionMode = selected.size > 0;

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
        }}
      >
        {inSelectionMode ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {selected.size} of {cases.length} selected
              {!allSelected && (
                <button
                  onClick={onSelectAll}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--blue)',
                    fontSize: 12,
                    cursor: 'pointer',
                    padding: 0,
                    marginLeft: 10,
                    fontFamily: 'inherit',
                  }}
                >
                  Select all
                </button>
              )}
              <button
                onClick={onClearSelection}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--muted)',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: 0,
                  marginLeft: 10,
                  fontFamily: 'inherit',
                }}
              >
                Clear
              </button>
            </div>
            <button
              onClick={onBulkDelete}
              disabled={bulkDeleting}
              style={{
                background: 'var(--red-soft-bg, #fef2f2)',
                color: 'var(--red)',
                border: '1px solid var(--red-soft-border, #fecaca)',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 13,
                fontWeight: 500,
                cursor: bulkDeleting ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'inherit',
                opacity: bulkDeleting ? 0.6 : 1,
              }}
            >
              {bulkDeleting ? (
                <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} />
              ) : (
                <Trash2 size={13} />
              )}
              Delete selected
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--muted)', minWidth: 0 }}>
              {loading ? 'Loading…' : `${cases.length} cases · ${approvedCount} approved · ${proposedCount} proposed`}
            </div>
            <button
              onClick={onNew}
              style={{
                background: 'var(--accent)',
                color: 'var(--accent-fg)',
                border: 'none',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'inherit',
              }}
            >
              <Plus size={14} /> Add
            </button>
          </>
        )}
      </div>

      {cases.length === 0 && !loading && (
        <div
          style={{
            border: '1px dashed var(--border-2)',
            borderRadius: 10,
            padding: '32px 16px',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 500, color: 'var(--text-2)', marginBottom: 4 }}>
            No test cases yet
          </div>
          Add your first case to start building a regression suite for this agent.
        </div>
      )}

      {cases.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
          {cases.map((c, idx) => (
            <div
              key={c.id}
              onClick={() => onEdit(c.id)}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr auto 28px 28px',
                gap: 10,
                alignItems: 'center',
                padding: '10px 14px',
                cursor: 'pointer',
                borderBottom: idx < cases.length - 1 ? '1px solid var(--border)' : 'none',
                background: selected.has(c.id) ? 'var(--surface-2)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleSelected(c.id)}
                aria-label="Select case"
                style={{ cursor: 'pointer', margin: 0 }}
              />
              <div style={{ overflow: 'hidden' }}>
                <div
                  style={{
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.question || '(empty question)'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {c.checks.length} check{c.checks.length === 1 ? '' : 's'} ·{' '}
                  {c.checks.map((ch) => UI_CHECK_LABEL[uiKindOf(ch)]).join(' + ')}
                </div>
              </div>
              <StatusPill status={c.status} />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(c.id);
                }}
                aria-label="Edit"
                style={iconBtnStyle}
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
                aria-label="Delete"
                style={{ ...iconBtnStyle, color: 'var(--red)' }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14, textAlign: 'center' }}>
        Cases marked <strong>approved</strong> run when you click <em>Run regression</em>.{' '}
        Proposed cases are skipped until reviewed.
      </div>
    </>
  );
}

function StatusPill({ status }: { status: 'approved' | 'proposed' }) {
  const isApproved = status === 'approved';
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: 10,
        background: isApproved ? 'var(--green-soft-bg, #ecfdf5)' : 'var(--surface-2)',
        color: isApproved ? 'var(--green)' : 'var(--muted)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {status}
    </span>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
  padding: 4,
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

// ─── Form view ────────────────────────────────────────────────────────────────

function FormView({
  agent,
  mcps,
  existing,
  onCancel,
  onAutoFilled,
  onSaved,
  onArchive,
}: {
  agent: Agent;
  mcps: McpServer[];
  existing: EvalCase | null;
  onCancel: () => void;
  onAutoFilled: () => void | Promise<void>;
  onSaved: () => void;
  onArchive: (id: string) => void;
}) {
  const [question, setQuestion] = useState(existing?.question ?? '');
  const [checks, setChecks] = useState<CheckConfig[]>(
    existing?.checks ?? [emptyCheck('substring_contain')],
  );
  const [status, setStatus] = useState<'approved' | 'proposed'>(
    existing?.status ?? 'approved',
  );
  // When Auto-fill persists a proposed case, we hold its id so Save can
  // PATCH (promote) instead of POST (create duplicate).
  const [autoFilledCaseId, setAutoFilledCaseId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoFilling, setAutoFilling] = useState(false);
  const [autoFillNote, setAutoFillNote] = useState<string | null>(null);

  async function autoFill() {
    if (autoFilling) return;
    // If the user clicks Auto-fill again before saving, delete the
    // previous proposed draft so we don't leave orphans behind.
    const previousId = autoFilledCaseId;
    setAutoFilling(true);
    setAutoFillNote(null);
    try {
      if (previousId) {
        await fetch(`/api/agents/${agent.id}/evals/cases/${previousId}`, {
          method: 'DELETE',
        }).catch(() => null);
        setAutoFilledCaseId(null);
      }
      const res = await fetch(`/api/agents/${agent.id}/evals/suggest-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1 }),
      });
      if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
      const body = (await res.json()) as { suggestions: EvalCase[] };
      const draft = body.suggestions[0];
      if (!draft) {
        setAutoFillNote(
          "Couldn't generate a valid case — try giving the agent a richer CLAUDE.md or linking MCP servers, then try again.",
        );
        return;
      }
      setQuestion(draft.question);
      setChecks(draft.checks);
      setAutoFilledCaseId(draft.id);
      await onAutoFilled();
    } catch (err) {
      setAutoFillNote(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoFilling(false);
    }
  }

  function updateCheck(idx: number, next: CheckConfig) {
    setChecks((prev) => prev.map((c, i) => (i === idx ? next : c)));
  }
  function changeCheckKind(idx: number, kind: UICheckKind) {
    setChecks((prev) => prev.map((c, i) => (i === idx ? emptyCheck(kind) : c)));
  }
  function addCheck() {
    setChecks((prev) => [...prev, emptyCheck('substring_contain')]);
  }
  function removeCheck(idx: number) {
    setChecks((prev) => prev.filter((_, i) => i !== idx));
  }

  async function save() {
    setError(null);
    if (!question.trim()) {
      setError('Question is required');
      return;
    }
    if (checks.length === 0) {
      setError('At least one check is required');
      return;
    }
    const cleaned = checks.map(cleanCheck);
    setSubmitting(true);
    try {
      let res: Response;
      // If Auto-fill already persisted a proposed case, promote it via
      // PATCH instead of POSTing a new one (which would leave the
      // proposed draft as a duplicate in the list).
      const promoteId = existing?.id ?? autoFilledCaseId;
      if (promoteId) {
        const body: UpdateEvalCaseRequest = { question, checks: cleaned, status };
        res = await fetch(`/api/agents/${agent.id}/evals/cases/${promoteId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        const body: CreateEvalCaseRequest = { question, checks: cleaned, status };
        res = await fetch(`/api/agents/${agent.id}/evals/cases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `Request failed: ${res.status}`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!existing && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            padding: '10px 12px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--surface-2)',
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Need a starting point? Auto-fill from this agent's context.
          </div>
          <button
            onClick={autoFill}
            disabled={autoFilling}
            style={{
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border-2)',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 12,
              cursor: autoFilling ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              opacity: autoFilling ? 0.7 : 1,
            }}
          >
            {autoFilling ? (
              <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} />
            ) : (
              <Sparkles size={13} />
            )}
            {autoFilling ? 'Generating…' : 'Auto-fill'}
          </button>
        </div>
      )}
      {autoFillNote && !existing && (
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--amber-soft-bg, #fffbeb)',
            border: '1px solid var(--amber-soft-border, #fde68a)',
            borderRadius: 6,
            color: 'var(--amber)',
            fontSize: 12,
          }}
        >
          {autoFillNote}
        </div>
      )}
      <Field label="Question" hint="The Slack message a user would send to the agent.">
        <textarea
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. How many engaged sessions in May 2025?"
          style={textareaStyle}
        />
      </Field>

      <div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--muted)',
            marginBottom: 4,
          }}
        >
          Checks
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          The agent&apos;s response must satisfy ALL of these.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {checks.map((check, idx) => (
            <CheckEditor
              key={idx}
              check={check}
              mcps={mcps}
              onChange={(next) => updateCheck(idx, next)}
              onChangeKind={(kind) => changeCheckKind(idx, kind)}
              onRemove={checks.length > 1 ? () => removeCheck(idx) : undefined}
            />
          ))}
        </div>

        <button
          onClick={addCheck}
          style={{
            marginTop: 10,
            background: 'transparent',
            border: '1px dashed var(--border-2)',
            color: 'var(--muted)',
            cursor: 'pointer',
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: 13,
            width: '100%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            fontFamily: 'inherit',
          }}
        >
          <Plus size={13} /> Add check
        </button>
      </div>

      <Field label="Status">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as 'approved' | 'proposed')}
          style={selectStyle}
        >
          <option value="approved">approved — runs in regression suite</option>
          <option value="proposed">proposed — needs review before approval</option>
        </select>
      </Field>

      {error && (
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--red-soft-bg, #fef2f2)',
            border: '1px solid var(--red-soft-border, #fecaca)',
            borderRadius: 6,
            color: 'var(--red)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: existing || autoFilledCaseId ? 'space-between' : 'flex-end',
          alignItems: 'center',
          paddingTop: 14,
          borderTop: '1px solid var(--border)',
          marginTop: 4,
        }}
      >
        {(existing || autoFilledCaseId) && (
          <button
            onClick={() => onArchive((existing?.id ?? autoFilledCaseId) as string)}
            style={{
              background: 'transparent',
              border: '1px solid var(--red-soft-border, #fecaca)',
              color: 'var(--red)',
              cursor: 'pointer',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 13,
              fontFamily: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={btnStyle}>
            Cancel
          </button>
          <button
            onClick={save}
            disabled={submitting}
            style={{ ...btnStyle, background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--accent)', fontWeight: 500 }}
          >
            {submitting && <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />}
            {existing ? 'Save changes' : 'Create case'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Per-check editor ─────────────────────────────────────────────────────────

function CheckEditor({
  check,
  mcps,
  onChange,
  onChangeKind,
  onRemove,
}: {
  check: CheckConfig;
  mcps: McpServer[];
  onChange: (next: CheckConfig) => void;
  onChangeKind: (kind: UICheckKind) => void;
  onRemove?: () => void;
}) {
  const kind = uiKindOf(check);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        background: 'var(--surface-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <select
          value={kind}
          onChange={(e) => onChangeKind(e.target.value as UICheckKind)}
          style={{ ...selectStyle, flex: 1, fontSize: 13 }}
        >
          {(Object.keys(UI_CHECK_LABEL) as UICheckKind[]).map((k) => (
            <option key={k} value={k}>
              {UI_CHECK_LABEL[k]}
            </option>
          ))}
        </select>
        {onRemove && (
          <button onClick={onRemove} aria-label="Remove check" style={iconBtnStyle}>
            <X size={13} />
          </button>
        )}
      </div>

      {kind === 'substring_contain' && (
        <SubstringEditor
          label="Phrases that must appear (one per line, case-insensitive)"
          values={(check as Extract<CheckConfig, { primitive: 'substring' }>).must_contain ?? []}
          onChange={(next) =>
            onChange({ primitive: 'substring', target: 'final_reply', must_contain: next })
          }
        />
      )}

      {kind === 'substring_not_contain' && (
        <SubstringEditor
          label="Phrases that must NOT appear (one per line)"
          values={(check as Extract<CheckConfig, { primitive: 'substring' }>).must_not_contain ?? []}
          onChange={(next) =>
            onChange({ primitive: 'substring', target: 'final_reply', must_not_contain: next })
          }
        />
      )}

      {kind === 'tool_called_must' && (
        <ToolCalledEditor
          label="Tools the agent must call (one per line, full mcp__server__tool form)"
          values={(check as Extract<CheckConfig, { primitive: 'tool_called' }>).must_call ?? []}
          mcps={mcps}
          onChange={(next) => onChange({ primitive: 'tool_called', must_call: next })}
        />
      )}

      {kind === 'tool_called_must_not' && (
        <ToolCalledEditor
          label="Tools the agent must NOT call (one per line)"
          values={(check as Extract<CheckConfig, { primitive: 'tool_called' }>).must_not_call ?? []}
          mcps={mcps}
          onChange={(next) => onChange({ primitive: 'tool_called', must_not_call: next })}
        />
      )}

      {kind === 'llm_judge' && (
        <LlmJudgeEditor
          check={check as Extract<CheckConfig, { primitive: 'llm_judge' }>}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function SubstringEditor({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <Field label={label}>
      <textarea
        rows={3}
        value={values.join('\n')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }
        placeholder={'session_duration_s > 10\nunique_pvid > 1'}
        style={{ ...textareaStyle, fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
    </Field>
  );
}

/**
 * Two-step picker for tool ids. Each entry row is { MCP server, tool } where
 * the tool dropdown is lazy-populated when the user picks an MCP.
 *
 * Wire shape stays identical to the old free-text editor — an array of
 * `mcp__server__tool` strings (or `mcp__server__*` for wildcards) — so the
 * check primitive doesn't care which UI authored the value.
 *
 * Backward compat: incoming values that can't be parsed into server+tool
 * fall back to a free-text input on that row.
 */
function ToolCalledEditor({
  label,
  values,
  mcps,
  onChange,
}: {
  label: string;
  values: string[];
  mcps: McpServer[];
  onChange: (next: string[]) => void;
}) {
  // Local state so partial entries (MCP picked, tool not yet) survive across
  // renders — entryToString drops them when serializing for the parent.
  const [entries, setEntries] = useState<ToolEntry[]>(() =>
    values.length > 0 ? values.map(parseToolValue) : [emptyEntry()],
  );

  function commit(next: ToolEntry[]) {
    setEntries(next);
    onChange(next.map(entryToString).filter((s) => s !== ''));
  }
  function updateEntry(idx: number, next: ToolEntry) {
    const out = entries.slice();
    out[idx] = next;
    commit(out);
  }
  function removeEntry(idx: number) {
    const out = entries.slice();
    out.splice(idx, 1);
    commit(out.length === 0 ? [emptyEntry()] : out);
  }
  function addEntry() {
    commit([...entries, emptyEntry()]);
  }

  return (
    <Field label={label}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.map((entry, i) => (
          <ToolEntryRow
            key={i}
            entry={entry}
            mcps={mcps}
            onChange={(next) => updateEntry(i, next)}
            onRemove={entries.length > 1 ? () => removeEntry(i) : undefined}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={addEntry}
        style={{
          marginTop: 8,
          padding: '4px 10px',
          fontSize: 12,
          background: 'transparent',
          border: '1px dashed var(--border-2)',
          borderRadius: 6,
          color: 'var(--muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <Plus size={12} /> Add tool
      </button>
      {mcps.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
          No MCP servers linked — link one in the agent's Tools tab to use this check.
        </div>
      )}
    </Field>
  );
}

interface ToolEntry {
  /** Linked-MCP name (e.g. "github"). null when the user hasn't picked yet. */
  serverName: string | null;
  /** Bare tool name (e.g. "get_pull_request"), `*` for wildcard, or null. */
  tool: string | null;
  /** Set when the original value couldn't be parsed — row renders as text input. */
  raw?: string;
}

function emptyEntry(): ToolEntry {
  return { serverName: null, tool: null };
}

function parseToolValue(value: string): ToolEntry {
  if (!value.startsWith('mcp__')) return { serverName: null, tool: null, raw: value };
  const secondUnderscore = value.indexOf('__', 5);
  if (secondUnderscore === -1) return { serverName: null, tool: null, raw: value };
  const serverName = value.slice(5, secondUnderscore);
  const tool = value.slice(secondUnderscore + 2);
  if (serverName === '' || tool === '') return { serverName: null, tool: null, raw: value };
  return { serverName, tool };
}

function entryToString(entry: ToolEntry): string {
  if (entry.raw !== undefined) return entry.raw.trim();
  if (entry.serverName === null || entry.tool === null) return '';
  return `mcp__${entry.serverName}__${entry.tool}`;
}

function ToolEntryRow({
  entry,
  mcps,
  onChange,
  onRemove,
}: {
  entry: ToolEntry;
  mcps: McpServer[];
  onChange: (next: ToolEntry) => void;
  onRemove?: () => void;
}) {
  const mcpForEntry = entry.serverName ? mcps.find((m) => m.name === entry.serverName) : null;
  const { tools, status, error, refresh } = useMcpTools(mcpForEntry?.id ?? null);

  // Raw fallback: when the original value can't be parsed, just show a text input.
  if (entry.raw !== undefined) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="text"
          value={entry.raw}
          onChange={(e) => onChange({ serverName: null, tool: null, raw: e.target.value })}
          placeholder="mcp__server__tool"
          style={{
            flex: 1,
            padding: '6px 10px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            background: 'var(--surface)',
            color: 'var(--text)',
          }}
        />
        {onRemove && (
          <button type="button" onClick={onRemove} style={toolIconBtnStyle} aria-label="Remove">
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr auto auto', gap: 6, alignItems: 'center' }}>
      <select
        value={entry.serverName ?? ''}
        onChange={(e) =>
          onChange({ serverName: e.target.value || null, tool: null })
        }
        style={selectStyle}
      >
        <option value="">Pick MCP…</option>
        {mcps.map((m) => (
          <option key={m.id} value={m.name}>
            {m.name}
          </option>
        ))}
      </select>

      <select
        value={entry.tool ?? ''}
        onChange={(e) => onChange({ ...entry, tool: e.target.value || null })}
        disabled={!entry.serverName || status === 'loading'}
        style={toolSelectStyle}
      >
        <option value="">
          {!entry.serverName
            ? 'Pick MCP first'
            : status === 'loading'
              ? 'Loading tools…'
              : status === 'error'
                ? `Error: ${error ?? 'failed'} — type manually`
                : 'Pick tool…'}
        </option>
        <option value="*">* (any tool from this MCP)</option>
        {tools.map((t) => (
          <option key={t.name} value={t.name} title={t.description}>
            {t.name}
          </option>
        ))}
        {/* If the existing value isn't in the fetched list (legacy or post-refresh removed), show it anyway so the user sees what's set. */}
        {entry.tool && entry.tool !== '*' && !tools.some((t) => t.name === entry.tool) && (
          <option value={entry.tool}>{entry.tool} (not in current list)</option>
        )}
      </select>

      <button
        type="button"
        onClick={refresh}
        disabled={!entry.serverName || status === 'loading'}
        style={toolIconBtnStyle}
        title="Refresh tool list"
        aria-label="Refresh tool list"
      >
        {status === 'loading' ? (
          <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
        ) : (
          <RefreshCw size={14} />
        )}
      </button>

      {onRemove && (
        <button type="button" onClick={onRemove} style={toolIconBtnStyle} aria-label="Remove">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

const toolSelectStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 12,
  fontFamily: 'inherit',
  background: 'var(--surface)',
  color: 'var(--text)',
};

const toolIconBtnStyle: React.CSSProperties = {
  padding: '4px 6px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
};

/**
 * Lazy fetcher + per-mount cache for an MCP's tool list. Keys by MCP id;
 * once a server's tools are fetched they stay in memory for the lifetime
 * of this hook instance so re-opening the dropdown is instant.
 */
function useMcpTools(mcpId: string | null) {
  const [byId, setById] = useState<Record<string, McpTool[]>>({});
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const fetchTools = useCallback(async (id: string, force = false) => {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(`/api/mcps/${id}/tools${force ? '?refresh=1' : ''}`);
      const body = (await res.json()) as { tools?: McpTool[]; error?: string };
      if (!res.ok) {
        setStatus('error');
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setById((prev) => ({ ...prev, [id]: body.tools ?? [] }));
      setStatus('ok');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (mcpId === null) {
      setStatus('idle');
      return;
    }
    if (byId[mcpId]) {
      setStatus('ok');
      return;
    }
    fetchTools(mcpId);
  }, [mcpId, byId, fetchTools]);

  const refresh = useCallback(() => {
    if (mcpId !== null) fetchTools(mcpId, true);
  }, [mcpId, fetchTools]);

  return {
    tools: mcpId !== null ? byId[mcpId] ?? [] : [],
    status,
    error,
    refresh,
  };
}

function LlmJudgeEditor({
  check,
  onChange,
}: {
  check: Extract<CheckConfig, { primitive: 'llm_judge' }>;
  onChange: (next: CheckConfig) => void;
}) {
  return (
    <>
      <Field label="Rubric (instructions to the judge)">
        <textarea
          rows={4}
          value={check.rubric}
          onChange={(e) =>
            onChange({ ...check, rubric: e.target.value })
          }
          placeholder={'Grade whether the SQL answers the question. PASS if the joins,\nfilters, and aggregations match the groundtruth; FAIL if wrong\ntable or wrong filter; SUSPECT if approximately right.'}
          style={textareaStyle}
        />
      </Field>
      <Field label="Groundtruth (optional, gives the judge an anchor)">
        <textarea
          rows={3}
          value={check.groundtruth ?? ''}
          onChange={(e) =>
            onChange({ ...check, groundtruth: e.target.value || undefined })
          }
          placeholder={'SELECT COUNT(DISTINCT ...) FROM ...'}
          style={{ ...textareaStyle, fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
      </Field>
      <div
        style={{
          fontSize: 11,
          color: 'var(--amber)',
          padding: '6px 10px',
          background: 'var(--amber-soft-bg, #fffbeb)',
          border: '1px solid var(--amber-soft-border, #fde68a)',
          borderRadius: 6,
        }}
      >
        Cost ~$0.01–0.05 per case. Vague rubrics produce SUSPECT verdicts.
      </div>
    </>
  );
}

// ─── Cleanup before save (drop empty arrays / fields) ─────────────────────────

function cleanCheck(c: CheckConfig): CheckConfig {
  if (c.primitive === 'substring') {
    return {
      primitive: 'substring',
      target: 'final_reply',
      ...(c.must_contain && c.must_contain.length > 0 ? { must_contain: c.must_contain } : {}),
      ...(c.must_not_contain && c.must_not_contain.length > 0 ? { must_not_contain: c.must_not_contain } : {}),
    };
  }
  if (c.primitive === 'tool_called') {
    return {
      primitive: 'tool_called',
      ...(c.must_call && c.must_call.length > 0 ? { must_call: c.must_call } : {}),
      ...(c.must_not_call && c.must_not_call.length > 0 ? { must_not_call: c.must_not_call } : {}),
    };
  }
  return c; // llm_judge passes through
}

// ─── Tiny shared widgets ──────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--muted)',
          marginBottom: 5,
        }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>
      )}
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid var(--border-2)',
  borderRadius: 6,
  fontSize: 13,
  fontFamily: 'inherit',
  resize: 'vertical',
  background: 'var(--surface)',
  color: 'var(--text)',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  border: '1px solid var(--border-2)',
  borderRadius: 6,
  fontSize: 13,
  fontFamily: 'inherit',
  background: 'var(--surface)',
  color: 'var(--text)',
};

const btnStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border-2)',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
  cursor: 'pointer',
  color: 'var(--text)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'inherit',
};
