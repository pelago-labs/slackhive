'use client';

/**
 * @fileoverview EvalsPanel — Tier 1 healthcheck UI for an agent's Evals tab.
 *
 * Fetches GET /api/agents/[id]/evals/healthcheck on mount, groups issues
 * by check code (QA001–QA007), and renders each check as a row with a
 * status badge. Clicking a check with issues expands the per-issue list.
 *
 * Tier 2 lives below as a "Coming soon" placeholder until the regression
 * runner backend ships.
 *
 * @module web/app/agents/[slug]/evals-panel
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, EvalCase, EvalRun, EvalRunResult } from '@slackhive/shared';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { EvalsCasesDrawer } from './evals-cases-drawer';
import { EvalsRunsDrawer } from './evals-runs-drawer';

type RunWithResults = { run: EvalRun; results: EvalRunResult[] };

const VERDICT_COLOR: Record<EvalRunResult['verdict'], { fg: string; bg: string }> = {
  PASS:    { fg: 'var(--green)', bg: '#dcfce7' },
  FAIL:    { fg: 'var(--red)',   bg: '#fee2e2' },
  SUSPECT: { fg: 'var(--amber)', bg: '#fef3c7' },
  INFRA:   { fg: 'var(--muted)', bg: 'var(--surface-2)' },
};

interface Issue {
  code: string;
  severity: 'error' | 'warn';
  file: string;
  line?: number;
  message: string;
}

interface HealthcheckResult {
  summary: { total: number; errors: number; warnings: number };
  issues: Issue[];
}

type CheckStatus = 'clean' | 'warn' | 'fail';

const CHECKS_META: Array<{ code: string; name: string; help: string }> = [
  { code: 'QA001', name: 'MCP coverage',      help: 'Flags `mcp__server__tool` refs whose server isn\'t linked to this agent.' },
  { code: 'QA002', name: 'Cross-refs',        help: 'Flags markdown links to skills or wiki entities that don\'t exist.' },
  { code: 'QA003', name: 'Trigger conflicts', help: 'Flags duplicate or prefix-overlapping Step 0 trigger phrases.' },
  { code: 'QA004', name: 'Skill overlap',     help: 'Flags skill pairs with ≥70% description overlap (Jaccard similarity).' },
  { code: 'QA005', name: 'Persona hygiene',   help: 'Flags banned patterns: force-push, rm -rf, prompt-injection markers, always-agree.' },
  { code: 'QA006', name: 'Tool prefix',       help: 'Flags bare hyphenated tool names that should use the mcp__ prefix.' },
  { code: 'QA007', name: 'Wiki coverage',     help: 'Flags wiki entities not referenced anywhere — possibly orphaned.' },
];

const spinStyle: React.CSSProperties = {
  animation: 'spin 0.8s linear infinite',
};

export function EvalsPanel({ agent }: { agent: Agent }) {
  const [data, setData] = useState<HealthcheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);
  const [hoveredHelp, setHoveredHelp] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerStartInNew, setDrawerStartInNew] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  async function handleSuggestCases() {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/evals/suggest-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 3 }),
      });
      if (!res.ok) throw new Error(`Suggest failed: ${res.status}`);
      await fetchCases();
      // Auto-open Manage drawer so user sees what was generated.
      setDrawerStartInNew(false);
      setDrawerOpen(true);
    } catch (err) {
      console.error(err);
    } finally {
      setSuggesting(false);
    }
  }
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [latest, setLatest] = useState<RunWithResults | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const caseCounts = {
    total: cases.length,
    approved: cases.filter((c) => c.status === 'approved').length,
    proposed: cases.filter((c) => c.status === 'proposed').length,
  };

  const fetchCases = useCallback(async () => {
    try {
      const r = await fetch(`/api/agents/${agent.id}/evals/cases`);
      if (r.ok) setCases((await r.json()) as EvalCase[]);
    } catch {
      // silent — informational only
    }
  }, [agent.id]);

  const loadRunDetail = useCallback(
    async (runId: string) => {
      try {
        const r = await fetch(`/api/agents/${agent.id}/evals/runs/${runId}`);
        if (r.ok) setLatest((await r.json()) as RunWithResults);
      } catch {
        // silent
      }
    },
    [agent.id],
  );

  const fetchLatestRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/agents/${agent.id}/evals/runs?limit=1`);
      if (!r.ok) return;
      const runs = (await r.json()) as EvalRun[];
      if (runs.length === 0) {
        setLatest(null);
        return;
      }
      await loadRunDetail(runs[0].id);
    } catch {
      // silent
    }
  }, [agent.id, loadRunDetail]);

  useEffect(() => {
    fetchCases();
    fetchLatestRun();
  }, [fetchCases, fetchLatestRun]);

  // Poll while a run is in flight. setInterval is fine here — DB queries
  // are cheap and the page only mounts on the Evals tab.
  useEffect(() => {
    if (latest?.run.status !== 'running') {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const runId = latest.run.id;
    pollRef.current = setInterval(() => loadRunDetail(runId), 2000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [latest?.run.status, latest?.run.id, loadRunDetail]);

  async function startRun() {
    if (startingRun) return;
    setStartingRun(true);
    try {
      const r = await fetch(`/api/agents/${agent.id}/evals/runs`, { method: 'POST' });
      if (!r.ok) throw new Error(`Run failed to start: ${r.status}`);
      const run = (await r.json()) as EvalRun;
      await loadRunDetail(run.id);
    } catch (err) {
      console.error(err);
    } finally {
      setStartingRun(false);
    }
  }

  const fetchHealthcheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/agents/${agent.id}/evals/healthcheck`);
      if (!r.ok) throw new Error(`Request failed: ${r.status} ${r.statusText}`);
      const json = (await r.json()) as HealthcheckResult;
      setData(json);
      setLastRunAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    fetchHealthcheck();
  }, [fetchHealthcheck]);

  function toggleCheck(code: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  // Group issues by check code (only meaningful if data is loaded)
  const issuesByCode = new Map<string, Issue[]>();
  data?.issues.forEach((i) => {
    if (!issuesByCode.has(i.code)) issuesByCode.set(i.code, []);
    issuesByCode.get(i.code)!.push(i);
  });

  function statusOf(code: string): CheckStatus {
    const issues = issuesByCode.get(code) ?? [];
    if (issues.some((i) => i.severity === 'error')) return 'fail';
    if (issues.some((i) => i.severity === 'warn')) return 'warn';
    return 'clean';
  }

  function countLabel(code: string): string {
    const issues = issuesByCode.get(code) ?? [];
    if (issues.length === 0) return 'clean';
    const errs = issues.filter((i) => i.severity === 'error').length;
    const warns = issues.length - errs;
    const parts: string[] = [];
    if (errs > 0) parts.push(`${errs} error${errs === 1 ? '' : 's'}`);
    if (warns > 0) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
    return parts.join(', ');
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1024, margin: '0 auto' }}>
      {/* ── Tier 1 ────────────────────────────────────────── */}
      <section>
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 16,
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
              Tier 1 · Static healthcheck
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              {loading ? 'Loading…' : error ? 'Failed to load' : describeSummary(data)}
              {lastRunAt && !loading && (
                <span> · last run {relativeTime(lastRunAt)}</span>
              )}
            </div>
          </div>
          <button
            onClick={fetchHealthcheck}
            disabled={loading}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border-2)',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 13,
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--text)',
              opacity: loading ? 0.6 : 1,
              fontFamily: 'inherit',
            }}
          >
            {loading ? (
              <Loader2 size={14} style={spinStyle} />
            ) : (
              <RotateCcw size={14} />
            )}
            Re-run
          </button>
        </header>

        {error && (
          <div
            style={{
              padding: '12px 16px',
              background: 'var(--red-soft-bg)',
              border: '1px solid var(--red-soft-border)',
              borderRadius: 8,
              color: 'var(--red)',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <AlertCircle size={16} />
            <span>Failed to run healthcheck: {error}</span>
          </div>
        )}

        {!error && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--surface)',
            }}
          >
            {CHECKS_META.map((meta, idx) => {
              const status = data ? statusOf(meta.code) : 'clean';
              const issues = issuesByCode.get(meta.code) ?? [];
              const hasIssues = issues.length > 0;
              const isOpen = expanded.has(meta.code);
              const isLast = idx === CHECKS_META.length - 1;
              return (
                <div key={meta.code}>
                  <div
                    onClick={() => hasIssues && toggleCheck(meta.code)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '24px 80px 1fr auto 20px',
                      gap: 14,
                      alignItems: 'center',
                      padding: '11px 14px',
                      cursor: hasIssues ? 'pointer' : 'default',
                      borderBottom: isLast && !isOpen ? 'none' : '1px solid var(--border)',
                      userSelect: 'none',
                    }}
                  >
                    <StatusIcon status={status} loading={loading} />
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--muted)',
                        fontWeight: 500,
                      }}
                    >
                      {meta.code}
                    </span>
                    <span style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {meta.name}
                      <span
                        onMouseEnter={() => setHoveredHelp(meta.code)}
                        onMouseLeave={() => setHoveredHelp(null)}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          position: 'relative',
                          display: 'inline-flex',
                          cursor: 'help',
                          color: 'var(--subtle)',
                        }}
                      >
                        <HelpCircle size={12} />
                        {hoveredHelp === meta.code && (
                          <span
                            style={{
                              position: 'absolute',
                              left: 'calc(100% + 8px)',
                              top: '50%',
                              transform: 'translateY(-50%)',
                              padding: '8px 12px',
                              background: '#1f2937',
                              color: '#ffffff',
                              fontSize: 12,
                              fontWeight: 400,
                              lineHeight: 1.45,
                              borderRadius: 6,
                              width: 'max-content',
                              maxWidth: 280,
                              whiteSpace: 'normal',
                              textAlign: 'left',
                              pointerEvents: 'none',
                              zIndex: 10,
                              boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
                            }}
                          >
                            {meta.help}
                          </span>
                        )}
                      </span>
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color:
                          status === 'fail'
                            ? 'var(--red)'
                            : status === 'warn'
                              ? 'var(--amber)'
                              : 'var(--muted)',
                        fontWeight: status === 'clean' ? 400 : 500,
                      }}
                    >
                      {loading ? '…' : countLabel(meta.code)}
                    </span>
                    <span style={{ color: 'var(--subtle)', display: 'flex' }}>
                      {hasIssues ? (
                        isOpen ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )
                      ) : null}
                    </span>
                  </div>
                  {isOpen && hasIssues && (
                    <div
                      style={{
                        padding: '10px 14px 14px 56px',
                        background: 'var(--surface-2)',
                        borderBottom: isLast ? 'none' : '1px solid var(--border)',
                      }}
                    >
                      {issues.map((issue, i) => (
                        <div
                          key={i}
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12,
                            padding: '5px 0',
                            color: 'var(--text-2)',
                            display: 'grid',
                            gridTemplateColumns: '12px 1fr auto',
                            gap: 8,
                            alignItems: 'baseline',
                          }}
                        >
                          <span
                            style={{
                              color:
                                issue.severity === 'error'
                                  ? 'var(--red)'
                                  : 'var(--amber)',
                              fontSize: 10,
                            }}
                          >
                            ●
                          </span>
                          <span>{issue.message}</span>
                          <span
                            style={{
                              color: 'var(--muted)',
                              fontSize: 11,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {issue.file}
                            {issue.line ? `:${issue.line}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Tier 2 ────────────────────────────────────────── */}
      <section style={{ marginTop: 32 }}>
        <header style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Tier 2 · Regression eval
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            Define test cases · run them to catch behavioral regressions.
          </div>
        </header>

        {/* Test cases sub-section */}
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            background: 'var(--surface)',
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Test cases</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {caseCounts.total === 0
                ? 'No cases yet'
                : `${caseCounts.total} case${caseCounts.total === 1 ? '' : 's'} · ${caseCounts.approved} approved · ${caseCounts.proposed} proposed`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {caseCounts.total === 0 ? (
              <>
                <button
                  onClick={handleSuggestCases}
                  disabled={suggesting}
                  style={{
                    background: 'var(--accent)',
                    color: 'var(--accent-fg)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '7px 14px',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: suggesting ? 'not-allowed' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontFamily: 'inherit',
                    opacity: suggesting ? 0.7 : 1,
                  }}
                >
                  {suggesting ? (
                    <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {suggesting ? 'Generating…' : 'Suggest cases'}
                </button>
                <button
                  onClick={() => {
                    setDrawerStartInNew(true);
                    setDrawerOpen(true);
                  }}
                  disabled={suggesting}
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border-2)',
                    borderRadius: 6,
                    padding: '7px 12px',
                    fontSize: 13,
                    cursor: suggesting ? 'not-allowed' : 'pointer',
                    color: 'var(--text)',
                    fontFamily: 'inherit',
                    opacity: suggesting ? 0.5 : 1,
                  }}
                >
                  + Add manually
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    setDrawerStartInNew(true);
                    setDrawerOpen(true);
                  }}
                  style={{
                    background: 'var(--accent)',
                    color: 'var(--accent-fg)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '7px 12px',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontFamily: 'inherit',
                  }}
                >
                  <Plus size={14} /> Add case
                </button>
                <button
                  onClick={() => {
                    setDrawerStartInNew(false);
                    setDrawerOpen(true);
                  }}
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border-2)',
                    borderRadius: 6,
                    padding: '7px 12px',
                    fontSize: 13,
                    cursor: 'pointer',
                    color: 'var(--text)',
                    fontFamily: 'inherit',
                  }}
                >
                  Manage cases
                </button>
              </>
            )}
          </div>
        </div>

        {/* Run regression card */}
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            background: 'var(--surface)',
            padding: '14px 16px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 14,
              marginBottom: latest?.run.status === 'done' ? 14 : 0,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Run regression</div>
              <RunSubtitle
                latest={latest}
                approvedCount={caseCounts.approved}
                onShowHistory={() => setHistoryOpen(true)}
              />
            </div>
            <button
              onClick={startRun}
              disabled={
                startingRun ||
                latest?.run.status === 'running' ||
                caseCounts.approved === 0
              }
              style={{
                background:
                  caseCounts.approved === 0 || latest?.run.status === 'running'
                    ? 'var(--surface-2)'
                    : 'var(--accent)',
                color:
                  caseCounts.approved === 0 || latest?.run.status === 'running'
                    ? 'var(--muted)'
                    : 'var(--accent-fg)',
                border: '1px solid var(--border-2)',
                borderRadius: 6,
                padding: '7px 12px',
                fontSize: 13,
                fontWeight: 500,
                cursor:
                  startingRun ||
                  latest?.run.status === 'running' ||
                  caseCounts.approved === 0
                    ? 'not-allowed'
                    : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              {latest?.run.status === 'running' || startingRun ? (
                <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
              ) : (
                <Play size={13} />
              )}
              Run regression
            </button>
          </div>

          {latest?.run.status === 'done' && (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 8,
                }}
              >
                <StatCard label="PASS" value={String(latest.run.passCount)} color="var(--green)" />
                <StatCard label="FAIL" value={String(latest.run.failCount)} color="var(--red)" />
                <StatCard
                  label="SUSPECT"
                  value={String(latest.run.suspectCount)}
                  color="var(--amber)"
                />
                <StatCard
                  label="Total time"
                  value={
                    latest.run.totalMs != null ? `${(latest.run.totalMs / 1000).toFixed(1)}s` : '—'
                  }
                  color="var(--muted)"
                />
              </div>

              {latest.results.some((r) => r.verdict !== 'PASS') && (
                <FailuresList
                  results={latest.results.filter((r) => r.verdict !== 'PASS')}
                  cases={cases}
                  expandedId={expandedResultId}
                  onToggle={(id) =>
                    setExpandedResultId(expandedResultId === id ? null : id)
                  }
                />
              )}
            </>
          )}
        </div>
      </section>

      <EvalsCasesDrawer
        agent={agent}
        open={drawerOpen}
        startInNew={drawerStartInNew}
        onClose={() => setDrawerOpen(false)}
        onCasesChanged={fetchCases}
      />

      <EvalsRunsDrawer
        agent={agent}
        open={historyOpen}
        currentRunId={latest?.run.id ?? null}
        onClose={() => setHistoryOpen(false)}
        onRunSelected={(runId) => loadRunDetail(runId)}
      />
    </div>
  );
}

// ─── Tier 2 sub-components ────────────────────────────────────────────────────

function RunSubtitle({
  latest,
  approvedCount,
  onShowHistory,
}: {
  latest: RunWithResults | null;
  approvedCount: number;
  onShowHistory: () => void;
}) {
  const subStyle: React.CSSProperties = { fontSize: 12, color: 'var(--muted)', marginTop: 2 };
  const historyLink = (
    <button
      onClick={onShowHistory}
      style={{
        background: 'transparent',
        border: 'none',
        color: 'var(--blue)',
        fontSize: 12,
        cursor: 'pointer',
        padding: 0,
        marginLeft: 6,
        textDecoration: 'none',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
    >
      View history ▸
    </button>
  );

  if (!latest) {
    if (approvedCount === 0) {
      return (
        <div style={subStyle}>Add and approve test cases above before running.</div>
      );
    }
    return <div style={subStyle}>No runs yet. Click Run regression to start.</div>;
  }
  const when = relativeTime(latest.run.startedAt);
  if (latest.run.status === 'running') {
    return (
      <div style={subStyle}>
        Running · started {when} by {latest.run.triggeredBy}
        {historyLink}
      </div>
    );
  }
  if (latest.run.status === 'error') {
    return (
      <div style={{ ...subStyle, color: 'var(--red)' }}>
        Last run errored · started {when}. Click to retry.
        {historyLink}
      </div>
    );
  }
  return (
    <div style={subStyle}>
      Last run · {when} by {latest.run.triggeredBy} ·{' '}
      {latest.run.passCount + latest.run.failCount + latest.run.suspectCount + latest.run.infraCount}{' '}
      cases
      {historyLink}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 600, color, lineHeight: 1.1 }}>{value}</div>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--muted)',
          marginTop: 4,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function FailuresList({
  results,
  cases,
  expandedId,
  onToggle,
}: {
  results: EvalRunResult[];
  cases: EvalCase[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--muted)',
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        Failures &amp; suspects · click to inspect
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
        {results.map((r, idx) => {
          const caseRow = cases.find((c) => c.id === r.caseId);
          const palette = VERDICT_COLOR[r.verdict];
          const isOpen = expandedId === r.id;
          const isLast = idx === results.length - 1;
          return (
            <div key={r.id}>
              <div
                onClick={() => onToggle(r.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto 14px',
                  gap: 10,
                  alignItems: 'center',
                  padding: '9px 12px',
                  cursor: 'pointer',
                  borderBottom:
                    isLast && !isOpen ? 'none' : '1px solid var(--border)',
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {caseRow?.question ?? `Case ${r.caseId.slice(0, 8)}`}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: palette.bg,
                    color: palette.fg,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {r.verdict}
                </span>
                <span style={{ color: 'var(--subtle)', display: 'flex' }}>
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>
              </div>
              {isOpen && (
                <div
                  style={{
                    padding: '12px 14px',
                    background: 'var(--surface-2)',
                    borderBottom: isLast ? 'none' : '1px solid var(--border)',
                    fontSize: 12,
                  }}
                >
                  {r.checkResults.map((cr, ci) => (
                    <div
                      key={ci}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '90px 70px 1fr',
                        gap: 8,
                        padding: '4px 0',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      <span style={{ color: 'var(--muted)' }}>{cr.primitive}</span>
                      <span style={{ color: VERDICT_COLOR[cr.verdict].fg, fontWeight: 600 }}>
                        {cr.verdict}
                      </span>
                      <span style={{ color: 'var(--text-2)' }}>{cr.message ?? '—'}</span>
                    </div>
                  ))}
                  {r.finalReply && (
                    <div style={{ marginTop: 10 }}>
                      <div
                        style={{
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color: 'var(--muted)',
                          fontWeight: 600,
                          marginBottom: 4,
                        }}
                      >
                        Final reply
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          fontFamily: 'var(--font-mono)',
                          background: 'var(--surface)',
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: '1px solid var(--border)',
                          maxHeight: 180,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {r.finalReply}
                      </div>
                    </div>
                  )}
                  {r.toolCalls && r.toolCalls.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div
                        style={{
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color: 'var(--muted)',
                          fontWeight: 600,
                          marginBottom: 4,
                        }}
                      >
                        Tool calls ({r.toolCalls.length})
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        {r.toolCalls.map((tc, ti) => (
                          <div key={ti} style={{ color: 'var(--text-2)', padding: '2px 0' }}>
                            {tc.toolId}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusIcon({
  status,
  loading,
}: {
  status: CheckStatus;
  loading: boolean;
}) {
  if (loading) {
    return (
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: 'var(--surface-2)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--subtle)',
        }}
      >
        <Loader2 size={11} style={spinStyle} />
      </span>
    );
  }
  const palette = {
    clean: { bg: '#dcfce7', fg: '#16a34a', icon: <Check size={11} strokeWidth={3} /> },
    warn: { bg: '#fef3c7', fg: '#d97706', icon: <AlertTriangle size={11} /> },
    fail: { bg: '#fee2e2', fg: '#dc2626', icon: <AlertCircle size={11} /> },
  }[status];
  return (
    <span
      style={{
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: palette.bg,
        color: palette.fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {palette.icon}
    </span>
  );
}

function describeSummary(data: HealthcheckResult | null): string {
  if (!data) return 'Loading…';
  const { summary } = data;
  if (summary.total === 0) return 'All 7 checks passed';
  const parts: string[] = [];
  if (summary.errors > 0)
    parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  if (summary.warnings > 0)
    parts.push(`${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`);
  return `${parts.join(', ')} across 7 checks`;
}

function relativeTime(d: Date | string | number): string {
  // API responses come back JSON-serialized — Dates become ISO strings.
  // TS lies; coerce at the boundary.
  const date = d instanceof Date ? d : new Date(d);
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  return `${Math.floor(diffSec / 3600)} hr ago`;
}
