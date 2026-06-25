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
  Eye,
  HelpCircle,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EvalsCasesDrawer } from './evals-cases-drawer';
import { EvalsRunsDrawer } from './evals-runs-drawer';
import { elapsedMmSs, relativeTime } from '@/lib/evals/format';

type RunWithResults = { run: EvalRun; results: EvalRunResult[] };

// Verdict pill colors: foreground token class + a soft background built from
// the same token via color-mix (the green/red/amber tokens are raw var() hex,
// so Tailwind opacity modifiers like bg-green/15 can't tint them — see report).
const VERDICT_COLOR: Record<
  EvalRunResult['verdict'],
  { fg: string; bg: string | undefined }
> = {
  PASS:    { fg: 'text-green', bg: 'color-mix(in srgb, var(--green) 15%, transparent)' },
  FAIL:    { fg: 'text-red',   bg: 'color-mix(in srgb, var(--red) 15%, transparent)' },
  SUSPECT: { fg: 'text-amber', bg: 'color-mix(in srgb, var(--amber) 15%, transparent)' },
  INFRA:   { fg: 'text-muted-foreground', bg: undefined },
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
  { code: 'QA004', name: 'Skill overlap',     help: 'Flags skill pairs with ≥70% description overlap (Jaccard similarity).' },
  { code: 'QA005', name: 'Persona hygiene',   help: 'Flags banned patterns: force-push, rm -rf, prompt-injection markers, always-agree.' },
  { code: 'QA006', name: 'PII & secrets',     help: 'Flags possible leaked secrets (API keys, tokens), financial IDs (credit card, SSN), and contact PII (email, phone) in CLAUDE.md and skills.' },
];

/**
 * Build the seed message Coach receives when the user clicks "Ask Coach" on
 * a failing eval row. The block is parsed by Coach's system prompt's
 * "Eval-failure triage" section, which classifies the failure and emits a
 * proposal of the right kind.
 */
function buildCoachSeed(
  agent: Agent,
  c: EvalCase | undefined,
  r: EvalRunResult,
): string {
  const lines: string[] = [
    `Diagnose this failing eval test case for agent "${agent.name}". Triage as skill_issue, test_mismatch, or real_failure per the rules in your system prompt, then either emit one proposal or ask one clarifying question.`,
    '',
    `<eval_failure agent="${agent.slug}" case_id="${r.caseId}" verdict="${r.verdict}">`,
    `question: ${c?.question ?? '(unknown — case not in local cache)'}`,
    '',
    'current_checks:',
    JSON.stringify(c?.checks ?? [], null, 2),
    '',
    'agent_final_reply:',
    r.finalReply ?? '(no reply captured)',
    '',
    'tool_calls_observed:',
    JSON.stringify(r.toolCalls ?? [], null, 2),
    '',
    'check_results:',
    JSON.stringify(r.checkResults, null, 2),
  ];
  if (r.judgeReasoning) {
    lines.push('', 'judge_reasoning:', r.judgeReasoning);
  }
  lines.push('</eval_failure>');
  return lines.join('\n');
}

export function EvalsPanel({
  agent,
  onAskCoach,
  onOpenCoach,
}: {
  agent: Agent;
  onAskCoach?: (seedMessage: string) => void;
  onOpenCoach?: () => void;
}) {
  const [data, setData] = useState<HealthcheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);
  const [hoveredHelp, setHoveredHelp] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerStartInNew, setDrawerStartInNew] = useState(false);
  const [drawerEditCaseId, setDrawerEditCaseId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
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

  // Coach applies an eval-case-check proposal → fire-and-forget refetch so the
  // case list reflects the new checks without a manual reload.
  useEffect(() => {
    const onRefresh = () => { fetchCases(); };
    window.addEventListener('slackhive:evals-refresh', onRefresh);
    return () => window.removeEventListener('slackhive:evals-refresh', onRefresh);
  }, [fetchCases]);

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
    <div className="max-w-[1024px]">
      {/* ── Tier 1 ────────────────────────────────────────── */}
      <section>
        <header className="flex justify-between items-end mb-4 gap-4">
          <div>
            <div className="text-xl font-semibold tracking-tight">
              Tier 1 · Static healthcheck
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              {loading ? 'Loading…' : error ? 'Failed to load' : describeSummary(data)}
              {lastRunAt && !loading && (
                <span> · last run {relativeTime(lastRunAt)}</span>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={fetchHealthcheck} disabled={loading}>
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RotateCcw size={14} />
            )}
            Re-run
          </Button>
        </header>

        {error && (
          <div
            className="px-4 py-3 rounded-lg text-red text-sm flex items-center gap-2 border"
            style={{
              background: 'var(--red-soft-bg)',
              borderColor: 'var(--red-soft-border)',
            }}
          >
            <AlertCircle size={16} />
            <span>Failed to run healthcheck: {error}</span>
          </div>
        )}

        {!error && (
          <div className="border border-border rounded-lg bg-card">
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
                    className={cn(
                      'grid grid-cols-[24px_1fr_auto_20px] gap-3.5 items-center px-3.5 py-2.5 select-none',
                      hasIssues ? 'cursor-pointer' : 'cursor-default',
                      isLast && !isOpen ? '' : 'border-b border-border',
                    )}
                  >
                    <StatusIcon status={status} loading={loading} />
                    <span className="text-sm inline-flex items-center gap-1.5">
                      {meta.name}
                      <span
                        onMouseEnter={() => setHoveredHelp(meta.code)}
                        onMouseLeave={() => setHoveredHelp(null)}
                        onClick={(e) => e.stopPropagation()}
                        className="relative inline-flex cursor-help text-muted-foreground"
                      >
                        <HelpCircle size={12} />
                        {hoveredHelp === meta.code && (
                          <span className="absolute left-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-3 py-2 bg-popover text-popover-foreground text-xs font-normal leading-[1.45] rounded-md w-max max-w-[280px] whitespace-normal text-left pointer-events-none z-10 shadow-lg border border-border">
                            {meta.help}
                          </span>
                        )}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'text-xs',
                        status === 'fail'
                          ? 'text-red'
                          : status === 'warn'
                            ? 'text-amber'
                            : 'text-muted-foreground',
                        status === 'clean' ? 'font-normal' : 'font-medium',
                      )}
                    >
                      {loading ? '…' : countLabel(meta.code)}
                    </span>
                    <span className="text-muted-foreground flex">
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
                      className={cn(
                        'pt-2.5 pr-3.5 pb-3.5 pl-14 bg-muted',
                        isLast ? '' : 'border-b border-border',
                      )}
                    >
                      {issues.map((issue, i) => (
                        <div
                          key={i}
                          className="font-mono text-xs py-[5px] text-foreground grid grid-cols-[12px_1fr_auto] gap-2 items-baseline"
                        >
                          <span
                            className={cn(
                              'text-[10px]',
                              issue.severity === 'error' ? 'text-red' : 'text-amber',
                            )}
                          >
                            ●
                          </span>
                          <span>{issue.message}</span>
                          <span className="text-muted-foreground text-2xs whitespace-nowrap">
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
      <section className="mt-8">
        <header className="mb-4">
          <div className="text-xl font-semibold tracking-tight">
            Tier 2 · Regression eval
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            Define test cases · run them to catch behavioral regressions.
          </div>
        </header>

        {/* Unified card: cases header (thin top row) + regression run body */}
        <div className="border border-border rounded-lg bg-card overflow-hidden">
          {latest?.run.status === 'running' && (
            <RunProgressBar
              approvedCases={cases.filter((c) => c.status === 'approved')}
              results={latest.results}
              passCount={latest.run.passCount}
              startedAt={latest.run.startedAt}
            />
          )}
          <div className="px-4 py-3.5">
          {/* Top row — cases summary + Manage cases */}
          <div className="flex items-center justify-between gap-3.5 pb-3 border-b border-border mb-3.5">
            <div className="text-sm">
              {caseCounts.total === 0 ? (
                <span className="text-muted-foreground">No cases yet</span>
              ) : (
                <>
                  <strong>
                    {caseCounts.total} case{caseCounts.total === 1 ? '' : 's'}
                  </strong>
                  <span className="text-muted-foreground">
                    {' · '}
                    {caseCounts.approved} approved · {caseCounts.proposed} proposed
                  </span>
                </>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDrawerStartInNew(caseCounts.total === 0);
                setDrawerOpen(true);
              }}
            >
              {caseCounts.total === 0 ? (
                <>
                  <Plus size={14} /> Add your first case
                </>
              ) : (
                'Manage cases'
              )}
            </Button>
          </div>

          <div
            className={cn(
              'flex items-center justify-between gap-3.5',
              latest?.run.status === 'done' ? 'mb-3.5' : 'mb-0',
            )}
          >
            <div className="flex-1 min-w-0">
              <RunHeader
                latest={latest}
                approvedCount={caseCounts.approved}
                onShowHistory={() => setHistoryOpen(true)}
              />
            </div>
            <div className="inline-flex items-center gap-2">
              {onOpenCoach && !agent.isBoss && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onOpenCoach}
                  title="Open Coach — chat with the agent's tuner without sending a failure context"
                >
                  <Wand2 size={13} />
                  Coach
                </Button>
              )}
              <Button
                size="sm"
                onClick={startRun}
                disabled={
                  startingRun ||
                  latest?.run.status === 'running' ||
                  caseCounts.approved === 0
                }
              >
                {latest?.run.status === 'running' || startingRun ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={13} />
                )}
                Run regression
              </Button>
            </div>
          </div>

          {latest?.run.status === 'done' && (
            <>
              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${latest.run.infraCount > 0 ? 5 : 4}, 1fr)`,
                }}
              >
                <StatCard label="PASS" value={String(latest.run.passCount)} color="text-green" />
                <StatCard label="FAIL" value={String(latest.run.failCount)} color="text-red" />
                <StatCard
                  label="SUSPECT"
                  value={String(latest.run.suspectCount)}
                  color="text-amber"
                />
                {latest.run.infraCount > 0 && (
                  <InfraStatCard
                    count={latest.run.infraCount}
                    onRetry={startRun}
                    disabled={startingRun}
                  />
                )}
                <StatCard
                  label="Total time"
                  value={
                    latest.run.totalMs != null ? `${(latest.run.totalMs / 1000).toFixed(1)}s` : '—'
                  }
                  color="text-muted-foreground"
                />
              </div>

              {(() => {
                const nonPass = latest.results.filter((r) => r.verdict !== 'PASS');
                const passed = latest.results.filter((r) => r.verdict === 'PASS');
                const hasInfra = nonPass.some((r) => r.verdict === 'INFRA');
                const onToggleRow = (id: string) =>
                  setExpandedResultId(expandedResultId === id ? null : id);
                const onOpenCase = (caseId: string) => {
                  setDrawerEditCaseId(caseId);
                  setDrawerOpen(true);
                };
                const onAskCoachRow = onAskCoach
                  ? (r: EvalRunResult) => {
                      const c = cases.find((x) => x.id === r.caseId);
                      onAskCoach(buildCoachSeed(agent, c, r));
                    }
                  : undefined;
                return (
                  <>
                    {nonPass.length > 0 && (
                      <ResultsList
                        title={
                          (hasInfra ? 'Failures, suspects & errors' : 'Failures & suspects') +
                          ' · click to inspect'
                        }
                        results={nonPass}
                        cases={cases}
                        expandedId={expandedResultId}
                        onToggle={onToggleRow}
                        onOpenCase={onOpenCase}
                        onAskCoach={onAskCoachRow}
                      />
                    )}
                    {passed.length > 0 && (
                      <ResultsList
                        title={`Passed (${passed.length}) · click to inspect`}
                        results={passed}
                        cases={cases}
                        expandedId={expandedResultId}
                        onToggle={onToggleRow}
                        onOpenCase={onOpenCase}
                        collapsible
                        defaultOpen={nonPass.length === 0}
                      />
                    )}
                  </>
                );
              })()}
            </>
          )}
          </div>
        </div>
      </section>

      <EvalsCasesDrawer
        agent={agent}
        open={drawerOpen}
        startInNew={drawerStartInNew}
        startInEditCaseId={drawerEditCaseId}
        onClose={() => {
          setDrawerOpen(false);
          setDrawerEditCaseId(null);
          setDrawerStartInNew(false);
        }}
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

// Segment color palette by verdict — matches FailuresList pills but used
// here to fill the segment background fully (not soft-bg).
const SEGMENT_COLOR: Record<EvalRunResult['verdict'], string> = {
  PASS: 'var(--green)',
  FAIL: 'var(--red)',
  SUSPECT: 'var(--amber)',
  INFRA: 'var(--subtle)',
};

/**
 * Segmented progress bar — one segment per approved case, sitting at the
 * top of the Tier 2 card while a run is in progress. Each segment shows
 * the live state of that case:
 *   - pending: outlined empty
 *   - running: outlined with an indeterminate sweep animation
 *   - completed: filled with the verdict color (PASS green, FAIL red,
 *     SUSPECT amber, INFRA gray)
 *
 * Doubles as a verdict heatmap once the run finishes — though only
 * rendered while status === 'running'.
 *
 * The label row below the segments ticks every second so elapsed time
 * stays current between the 2-second poll interval.
 */
function RunProgressBar({
  approvedCases,
  results,
  passCount,
  startedAt,
}: {
  approvedCases: EvalCase[];
  results: EvalRunResult[];
  passCount: number;
  startedAt: Date | string;
}) {
  // Tick every second so the M:SS elapsed counter stays smooth even
  // though the parent only polls every 2s.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Map each approved case (creation order) to its current state. Cases
  // run sequentially in creation order; the first case without a result
  // is the one currently executing.
  const resultByCaseId = new Map(results.map((r) => [r.caseId, r]));
  let runningFound = false;
  const segments = approvedCases.map((c) => {
    const result = resultByCaseId.get(c.id);
    if (result) return { state: 'done' as const, verdict: result.verdict };
    if (!runningFound) {
      runningFound = true;
      return { state: 'running' as const };
    }
    return { state: 'pending' as const };
  });

  const total = approvedCases.length;
  const done = results.length;
  const currentIdx = done; // 0-based index of the currently-running case
  const elapsed = elapsedMmSs(startedAt);

  return (
    <div className="px-4 pt-3 pb-2.5 border-b border-border">
      <div className="grid grid-flow-col auto-cols-fr gap-1">
        {segments.map((seg, i) => {
          if (seg.state === 'done') {
            const color = SEGMENT_COLOR[seg.verdict];
            return (
              <div
                key={i}
                className="h-2 rounded-[4px]"
                style={{ background: color, border: `1px solid ${color}` }}
              />
            );
          }
          if (seg.state === 'running') {
            return (
              <div
                key={i}
                className="h-2 rounded-[4px] bg-muted border border-blue relative overflow-hidden"
              >
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      'linear-gradient(90deg, transparent 0%, var(--blue) 40%, var(--blue) 60%, transparent 100%)',
                    animation: 'indeterm-sweep 1.4s ease-in-out infinite',
                    transformOrigin: 'left center',
                  }}
                />
              </div>
            );
          }
          return (
            <div key={i} className="h-2 rounded-[4px] bg-muted border border-border" />
          );
        })}
      </div>
      <div className="flex justify-between text-2xs text-muted-foreground mt-1.5 tabular-nums">
        <span>
          {done >= total
            ? 'Wrapping up…'
            : `Case ${Math.min(currentIdx + 1, total)} of ${total} · running`}
        </span>
        <span>
          {passCount > 0 ? `${passCount} PASS · ` : ''}
          {elapsed} elapsed
        </span>
      </div>
    </div>
  );
}

function RunHeader({
  latest,
  approvedCount,
  onShowHistory,
}: {
  latest: RunWithResults | null;
  approvedCount: number;
  onShowHistory: () => void;
}) {
  const titleClass = 'text-base font-semibold';
  const subClass = 'text-xs text-muted-foreground mt-0.5';
  const historyLink = (
    <button
      onClick={onShowHistory}
      className="bg-transparent border-0 text-blue text-xs cursor-pointer p-0 ml-1.5 no-underline hover:underline font-[inherit]"
    >
      View history ▸
    </button>
  );

  if (!latest) {
    return (
      <>
        <div className={titleClass}>Run regression</div>
        <div className={subClass}>
          {approvedCount === 0
            ? 'Add and approve test cases above before running.'
            : 'No runs yet. Click Run regression to start.'}
        </div>
      </>
    );
  }

  const when = relativeTime(latest.run.startedAt);

  if (latest.run.status === 'running') {
    const { passCount, failCount, suspectCount, infraCount } = latest.run;
    const done = passCount + failCount + suspectCount + infraCount;
    const total = Math.max(approvedCount, done + 1);
    const partial = [
      passCount > 0 && `${passCount} PASS`,
      failCount > 0 && `${failCount} FAIL`,
      suspectCount > 0 && `${suspectCount} SUSPECT`,
      infraCount > 0 && `${infraCount} INFRA`,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <>
        <div className={titleClass}>
          Running case {done + 1} of {total}
        </div>
        <div className={subClass}>
          {partial && partial + ' · '}started {when}
          {historyLink}
        </div>
      </>
    );
  }

  if (latest.run.status === 'error') {
    return (
      <>
        <div className={cn(titleClass, 'text-red')}>Last run errored</div>
        <div className={subClass}>
          Started {when}. Click Run regression to retry.
          {historyLink}
        </div>
      </>
    );
  }

  // done
  const total =
    latest.run.passCount +
    latest.run.failCount +
    latest.run.suspectCount +
    latest.run.infraCount;
  return (
    <>
      <div className={titleClass}>
        Last run · {when} by {latest.run.triggeredBy}
      </div>
      <div className={subClass}>
        {total} case{total === 1 ? '' : 's'}
        {latest.run.totalMs != null && ` · ${(latest.run.totalMs / 1000).toFixed(1)}s`}
        {historyLink}
      </div>
    </>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-muted border border-border rounded-lg px-3 py-2.5">
      <div className={cn('text-xl font-semibold leading-[1.1]', color)}>{value}</div>
      <div className="text-2xs uppercase tracking-[0.05em] text-muted-foreground mt-1 font-semibold">
        {label}
      </div>
    </div>
  );
}

/**
 * INFRA tile that doubles as a Retry button. Only rendered when
 * infraCount > 0 — see Option D in tier2-infra-display.html. INFRA is the
 * one verdict the user can act on (the agent didn't fail; the runner did),
 * so the count and the verb live in the same place. Retry currently
 * triggers a full regression rerun via the same handler as the main
 * "Run regression" button.
 */
function InfraStatCard({
  count,
  onRetry,
  disabled,
}: {
  count: number;
  onRetry: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={disabled}
      className={cn(
        'bg-muted border border-input rounded-lg px-3 py-2.5 text-left font-[inherit] transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-secondary',
      )}
    >
      <div className="text-xl font-semibold text-muted-foreground leading-[1.1]">
        {count}
      </div>
      <div className="text-2xs uppercase tracking-[0.05em] text-muted-foreground mt-1 font-semibold">
        Infra error
      </div>
      <div className="text-2xs text-blue mt-1.5 font-medium">
        Retry ▸
      </div>
    </button>
  );
}

function ResultsList({
  title,
  results,
  cases,
  expandedId,
  onToggle,
  onOpenCase,
  onAskCoach,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string;
  results: EvalRunResult[];
  cases: EvalCase[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onOpenCase?: (caseId: string) => void;
  onAskCoach?: (result: EvalRunResult) => void;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [sectionOpen, setSectionOpen] = useState(defaultOpen);
  const isOpen = collapsible ? sectionOpen : true;
  return (
    <div className="mt-3.5">
      <div
        onClick={collapsible ? () => setSectionOpen((v) => !v) : undefined}
        className={cn(
          'text-2xs uppercase tracking-[0.04em] text-muted-foreground font-semibold mb-1.5 flex items-center gap-1.5 select-none',
          collapsible ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        {collapsible &&
          (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        {title}
      </div>
      {isOpen && (
      <div className="border border-border rounded-lg">
        {results.map((r, idx) => {
          const caseRow = cases.find((c) => c.id === r.caseId);
          const palette = VERDICT_COLOR[r.verdict];
          const isOpen = expandedId === r.id;
          const isLast = idx === results.length - 1;
          const showPencil = !!(onOpenCase && caseRow);
          const showAskCoach = !!onAskCoach;
          const cols = ['1fr', 'auto'];
          if (showPencil) cols.push('auto');
          cols.push('14px');
          return (
            <div key={r.id}>
              <div
                onClick={() => onToggle(r.id)}
                className={cn(
                  'grid gap-2.5 items-center px-3 py-2.5 cursor-pointer',
                  isLast && !isOpen ? '' : 'border-b border-border',
                )}
                style={{ gridTemplateColumns: cols.join(' ') }}
              >
                <span className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">
                  {caseRow?.question ?? `Case ${r.caseId.slice(0, 8)}`}
                </span>
                <span
                  className={cn(
                    'text-2xs font-semibold px-2 py-0.5 rounded-[10px] font-mono',
                    palette.bg ? '' : 'bg-muted',
                    palette.fg,
                  )}
                  style={palette.bg ? { background: palette.bg } : undefined}
                >
                  {r.verdict}
                </span>
                {showPencil && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenCase!(caseRow!.id);
                    }}
                    title="View this test case (editable)"
                    aria-label="View this test case (editable)"
                    className="bg-transparent border-0 p-1 cursor-pointer text-muted-foreground inline-flex items-center justify-center rounded-[4px] hover:bg-secondary"
                  >
                    <Eye size={14} />
                  </button>
                )}
                <span className="text-muted-foreground flex">
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>
              </div>
              {isOpen && (
                <div
                  className={cn(
                    'px-3.5 py-3 bg-muted text-xs',
                    isLast ? '' : 'border-b border-border',
                  )}
                >
                  {r.checkResults.map((cr, ci) => (
                    <div
                      key={ci}
                      className="grid grid-cols-[90px_70px_1fr] gap-2 py-1 font-mono"
                    >
                      <span className="text-muted-foreground">{cr.primitive}</span>
                      <span className={cn('font-semibold', VERDICT_COLOR[cr.verdict].fg)}>
                        {cr.verdict}
                      </span>
                      <span className="text-foreground">{cr.message ?? '—'}</span>
                    </div>
                  ))}
                  {r.finalReply && (
                    <div className="mt-2.5">
                      <div className="text-2xs uppercase tracking-[0.04em] text-muted-foreground font-semibold mb-1">
                        Final reply
                      </div>
                      <div className="text-xs font-mono bg-card px-2.5 py-2 rounded-md border border-border max-h-[180px] overflow-auto whitespace-pre-wrap">
                        {r.finalReply}
                      </div>
                    </div>
                  )}
                  {r.toolCalls && r.toolCalls.length > 0 && (
                    <div className="mt-2.5">
                      <div className="text-2xs uppercase tracking-[0.04em] text-muted-foreground font-semibold mb-1">
                        Tool calls ({r.toolCalls.length})
                      </div>
                      <div className="font-mono text-2xs">
                        {r.toolCalls.map((tc, ti) => (
                          <div key={ti} className="text-foreground py-0.5">
                            {tc.toolId}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {showAskCoach && (
                    <div className="flex justify-end mt-3 pt-3 border-t border-dashed border-border">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAskCoach!(r);
                        }}
                        title="Ask Coach to debug this failure"
                        aria-label="Ask Coach to debug this failure"
                        className="bg-primary/10 border border-primary text-primary px-3 py-1.5 cursor-pointer inline-flex items-center gap-1.5 rounded-md text-xs font-semibold leading-tight hover:bg-primary/15"
                      >
                        <Sparkles size={12} />
                        Ask Coach about this failure
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
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
      <span className="w-[18px] h-[18px] rounded-full bg-muted inline-flex items-center justify-center text-muted-foreground">
        <Loader2 size={11} className="animate-spin" />
      </span>
    );
  }
  const palette = {
    clean: { token: '--green', fg: 'text-green', icon: <Check size={11} strokeWidth={3} /> },
    warn: { token: '--amber', fg: 'text-amber', icon: <AlertTriangle size={11} /> },
    fail: { token: '--red', fg: 'text-red', icon: <AlertCircle size={11} /> },
  }[status];
  return (
    <span
      className={cn(
        'w-[18px] h-[18px] rounded-full inline-flex items-center justify-center',
        palette.fg,
      )}
      style={{ background: `color-mix(in srgb, var(${palette.token}) 18%, transparent)` }}
    >
      {palette.icon}
    </span>
  );
}

function describeSummary(data: HealthcheckResult | null): string {
  if (!data) return 'Loading…';
  const { summary } = data;
  if (summary.total === 0) return `All ${CHECKS_META.length} checks passed`;
  const parts: string[] = [];
  if (summary.errors > 0)
    parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  if (summary.warnings > 0)
    parts.push(`${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`);
  return `${parts.join(', ')} across ${CHECKS_META.length} checks`;
}
