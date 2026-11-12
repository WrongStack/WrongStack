import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Coins,
  FileCode2,
  GitCommit,
  History,
  Loader2,
  Plus,
  RotateCw,
  Send,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { chatLane, DEFAULT_LANE_ID } from '@/stores/chat-lanes';
import { useChimeraHubStore } from '@/stores/chimera-hub-store';
import { ChimeraReviewsHeader } from './ChimeraReviewsHeader';
import {
  fmtCompactTokens,
  fmtRelative,
  fmtTime,
  fmtUsdCost,
  LIFECYCLE_BADGE,
  SEVERITY_COLORS,
  SKIPPED_FILE_REASON_KEY,
} from './chimera-review-format.js';
import { EmptyState } from './ui/empty-state';

export function ChimeraReviewsView() {
  const { t } = useAppTranslation();
  const {
    reports,
    selectedReportId,
    detail,
    loading,
    detailLoading,
    error,
    filterSessionId,
    filterLifecycle,
    searchQuery,
    fetchReports,
    selectReport,
    setFilterSessionId,
    setFilterLifecycle,
    setSearchQuery,
    transitionReport,
    addReportNote,
    transitionFinding,
  } = useChimeraHubStore();

  const [noteText, setNoteText] = useState('');
  const [showRawText, setShowRawText] = useState(false);
  const [showSkippedFiles, setShowSkippedFiles] = useState(false);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  // Unique session list for the filter
  const sessionList = useMemo(() => {
    const s = new Set<string>();
    for (const r of reports) {
      if (r.sessionId) s.add(r.sessionId);
    }
    return Array.from(s);
  }, [reports]);

  // Filtered reports
  const filteredReports = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return reports.filter((r) => {
      if (filterSessionId && r.sessionId !== filterSessionId) return false;
      if (filterLifecycle && r.lifecycleStatus !== filterLifecycle) return false;
      if (q) {
        const matchesId = r.reportId.toLowerCase().includes(q);
        const matchesSession = r.sessionId.toLowerCase().includes(q);
        const matchesModel = (r.reviewerModel ?? '').toLowerCase().includes(q);
        if (!matchesId && !matchesSession && !matchesModel) return false;
      }
      return true;
    });
  }, [reports, filterSessionId, filterLifecycle, searchQuery]);

  // Aggregate token & cache telemetry across currently filtered reports
  const aggregateTelemetry = useMemo(() => {
    let totalTokens = 0;
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let totalCostUsd = 0;
    let reportsWithUsage = 0;
    for (const r of filteredReports) {
      if (r.usage && r.usage.totalTokens > 0) {
        reportsWithUsage++;
        totalTokens += r.usage.totalTokens;
        inputTokens += r.usage.inputTokens;
        cacheReadTokens += r.usage.cacheReadTokens ?? 0;
        totalCostUsd += r.usage.costUsd;
      }
    }
    const denom = inputTokens + cacheReadTokens;
    const cacheHitPct = denom > 0 ? Math.round((cacheReadTokens / denom) * 100) : 0;
    return { totalTokens, cacheReadTokens, cacheHitPct, totalCostUsd, reportsWithUsage };
  }, [filteredReports]);

  const handleAddNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReportId || !noteText.trim()) return;
    addReportNote(selectedReportId, noteText.trim());
    setNoteText('');
  };

  const handleSendToLeader = () => {
    if (!detail?.report) return;
    const rep = detail.report;
    const prompt =
      `Take a look at the tasks mentioned in Chimera report (${rep.id}) for session ${rep.sessionId} — ` +
      `review the ${rep.totalFindings} finding(s) it flagged and address them.`;

    const lane = chatLane(rep.sessionId);
    lane.addMessage({ role: 'user', content: prompt });
    lane.patch({ isLoading: true });

    getWSClient().sendMessage(
      prompt,
      undefined,
      false,
      rep.sessionId !== DEFAULT_LANE_ID ? rep.sessionId : undefined,
    );

    transitionReport(rep.id, 'actioned', 'Prompt dispatched to leader');
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background text-foreground [overflow-wrap:anywhere]">
      {/* Top Header / Filter Bar */}
      <ChimeraReviewsHeader
        sessionList={sessionList}
        filterSessionId={filterSessionId}
        setFilterSessionId={setFilterSessionId}
        filterLifecycle={filterLifecycle}
        setFilterLifecycle={setFilterLifecycle}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        loading={loading}
        fetchReports={fetchReports}
      />

      {/* Main 3-column / Split View */}
      <div className="flex flex-1 min-h-0 min-w-0 flex-col sm:flex-row">
        {/* Left Pane: Reports List */}
        <div className="flex w-full max-h-40 sm:max-h-none sm:w-80 flex-col border-b sm:border-b-0 sm:border-r border-border bg-card/20 shrink-0 overflow-y-auto">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
            <span>Reports ({filteredReports.length})</span>
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>
          {aggregateTelemetry.reportsWithUsage > 0 && aggregateTelemetry.totalTokens > 0 && (
            <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px] font-mono text-muted-foreground flex flex-wrap items-center gap-1.5">
              <Coins className="h-3 w-3 text-primary shrink-0" />
              <span className="font-semibold text-foreground">
                Σ {fmtCompactTokens(aggregateTelemetry.totalTokens)}{' '}
                {t('activity:chimeraReport.tokensShort', { defaultValue: 'tok' })}
              </span>
              {aggregateTelemetry.cacheReadTokens > 0 && (
                <span className="text-success">
                  · {aggregateTelemetry.cacheHitPct}%{' '}
                  {t('activity:chimeraReport.cacheShort', { defaultValue: 'cache' })}
                </span>
              )}
              {aggregateTelemetry.totalCostUsd > 0 && (
                <span>· {fmtUsdCost(aggregateTelemetry.totalCostUsd)}</span>
              )}
            </div>
          )}

          {error && !loading && (
            <div className="m-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="font-mono text-xs break-words text-destructive">{error}</p>
            </div>
          )}

          {filteredReports.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {loading ? 'Loading review reports…' : 'No review reports match your filter.'}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {filteredReports.map((r) => {
                const isSelected = r.reportId === selectedReportId;
                const badge = LIFECYCLE_BADGE[r.lifecycleStatus] ?? LIFECYCLE_BADGE['open'];
                const BadgeIcon = badge.icon;
                const total = r.totalFindings;

                return (
                  <button
                    key={r.reportId}
                    type="button"
                    onClick={() => selectReport(r.reportId)}
                    className={cn(
                      'flex w-full flex-col gap-1.5 px-3.5 py-3 text-left transition-colors hover:bg-muted/60',
                      isSelected && 'bg-primary/10 border-l-2 border-primary',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold truncate font-mono text-foreground">
                        {r.reportId.slice(0, 12)}…
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
                          badge.cls,
                        )}
                      >
                        <BadgeIcon className="h-2.5 w-2.5" />
                        {badge.label}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="truncate">Sess: {r.sessionId.slice(0, 10)}…</span>
                      <span>{fmtRelative(r.reviewedAt)}</span>
                    </div>

                    {/* Findings & severity counters */}
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">
                        {total === 0 ? (
                          <span className="text-success font-medium">All clear ✓</span>
                        ) : (
                          `${total} finding(s)`
                        )}
                      </span>
                      {r.counts && total > 0 && (
                        <div className="flex items-center gap-1 font-mono text-[10px]">
                          {r.counts.critical > 0 && (
                            <span className="text-destructive font-semibold">
                              {r.counts.critical} critical
                            </span>
                          )}
                          {r.counts.high > 0 && (
                            <span className="text-warning">{r.counts.high} high</span>
                          )}
                          {r.counts.medium > 0 && (
                            <span className="text-warning">{r.counts.medium} med</span>
                          )}
                          {r.counts.low > 0 && (
                            <span className="text-muted-foreground">{r.counts.low} low</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Compact token / cost / HEAD strip */}
                    {(r.usage?.totalTokens || r.headSha || (r.skippedFileCount ?? 0) > 0) && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-muted-foreground pt-0.5">
                        {r.headSha && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-muted/70 px-1.5 py-0.5">
                            <GitCommit className="h-2.5 w-2.5" />
                            {r.headSha.slice(0, 8)}
                          </span>
                        )}
                        {r.usage && r.usage.totalTokens > 0 && (
                          <span className="inline-flex items-center gap-1 rounded bg-muted/70 px-1.5 py-0.5">
                            {fmtCompactTokens(r.usage.totalTokens)}{' '}
                            {t('activity:chimeraReport.tokensShort', { defaultValue: 'tok' })}
                            {r.usage.costUsd > 0 ? ` · ${fmtUsdCost(r.usage.costUsd)}` : ''}
                          </span>
                        )}
                        {(r.skippedFileCount ?? 0) > 0 && (
                          <span className="rounded bg-muted/50 px-1.5 py-0.5">
                            {t('activity:chimeraReport.skippedShort', {
                              count: r.skippedFileCount,
                              defaultValue: '{{count}} skipped',
                            })}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Middle & Right Pane: Report Detail, Findings & Journal */}
        {selectedReportId && detail?.report ? (
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto lg:flex lg:overflow-hidden">
            {/* Center Area: Findings and Overview */}
            <div className="min-h-0 min-w-0 lg:flex-1 lg:overflow-y-auto p-4 sm:p-6 space-y-6">
              {/* Report Header Card */}
              <div className="rounded-xl border border-border bg-card p-5 space-y-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-bold">
                        Review Report{' '}
                        <span className="font-mono text-sm text-muted-foreground">
                          ({detail.report.id})
                        </span>
                      </h2>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Session{' '}
                      <span className="font-mono font-medium text-foreground">
                        {detail.report.sessionId}
                      </span>{' '}
                      • Reviewed at {fmtTime(detail.report.reviewedAt)}
                    </p>
                  </div>

                  {/* Status switcher & actions */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        transitionReport(detail.report!.id, 'actioned', 'Manual action status')
                      }
                      disabled={detail.report.lifecycle === 'actioned'}
                      className="inline-flex items-center gap-1 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning hover:bg-warning/20 disabled:opacity-40 transition-colors"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      Mark Actioned
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        transitionReport(detail.report!.id, 'completed', 'Manual completion')
                      }
                      disabled={detail.report.lifecycle === 'completed'}
                      className="inline-flex items-center gap-1 rounded-lg border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 disabled:opacity-40 transition-colors"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Mark Completed
                    </button>
                    <button
                      type="button"
                      onClick={() => transitionReport(detail.report!.id, 'skipped', 'Manual skip')}
                      disabled={detail.report.lifecycle === 'skipped'}
                      className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80 disabled:opacity-40 transition-colors"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Skip
                    </button>
                  </div>
                </div>

                {/* Metadata Pills */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-border/60 text-xs">
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Reviewer Model</span>
                    <span className="font-mono font-medium text-foreground">
                      {detail.report.reviewerModel || 'default'}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Reviewed Files</span>
                    <span className="font-medium text-foreground">
                      {detail.report.files.length} file(s)
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Total Findings</span>
                    <span className="font-semibold text-foreground">
                      {detail.report.totalFindings}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Cascade Depth</span>
                    <span className="font-medium text-foreground">
                      {detail.report.cascadeDepth ?? 0}
                    </span>
                  </div>
                </div>

                {/* Token & Execution Telemetry Strip */}
                {detail.report.usage && (
                  <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-xs space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                        <Coins className="h-3.5 w-3.5 text-primary" />
                        {t('activity:chimeraReport.telemetryHeading', {
                          defaultValue: 'Token & Execution Telemetry',
                        })}
                      </span>
                      {detail.report.usage.costUsd > 0 && (
                        <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-foreground">
                          {fmtUsdCost(detail.report.usage.costUsd)}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 font-mono text-[11px]">
                      <div>
                        <span className="text-muted-foreground block font-sans text-[10px]">
                          {t('activity:chimeraReport.totalTokensLabel', {
                            defaultValue: 'Total Tokens',
                          })}
                        </span>
                        <span className="font-semibold text-foreground">
                          {detail.report.usage.totalTokens.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground ml-1">
                          ({fmtCompactTokens(detail.report.usage.inputTokens)} in /{' '}
                          {fmtCompactTokens(detail.report.usage.outputTokens)} out)
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block font-sans text-[10px]">
                          {t('activity:chimeraReport.cacheReadLabel', {
                            defaultValue: 'Prompt Cache Read',
                          })}
                        </span>
                        <span className="font-medium text-foreground">
                          {(detail.report.usage.cacheReadTokens ?? 0).toLocaleString()}
                        </span>
                        {(detail.report.usage.cacheReadTokens ?? 0) > 0 &&
                          detail.report.usage.inputTokens +
                            (detail.report.usage.cacheReadTokens ?? 0) >
                            0 && (
                            <span className="text-success ml-1">
                              (
                              {Math.round(
                                ((detail.report.usage.cacheReadTokens ?? 0) /
                                  (detail.report.usage.inputTokens +
                                    (detail.report.usage.cacheReadTokens ?? 0))) *
                                  100,
                              )}
                              %)
                            </span>
                          )}
                      </div>
                      <div>
                        <span className="text-muted-foreground block font-sans text-[10px]">
                          {t('activity:chimeraReport.executionLabel', {
                            defaultValue: 'Turns / Tool Calls',
                          })}
                        </span>
                        <span className="font-medium text-foreground">
                          {detail.report.usage.iterations ?? 0} /{' '}
                          {detail.report.usage.toolCalls ?? 0}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block font-sans text-[10px]">
                          {t('activity:chimeraReport.durationAttemptsLabel', {
                            defaultValue: 'Duration / Attempts',
                          })}
                        </span>
                        <span className="font-medium text-foreground">
                          {detail.report.usage.durationMs !== undefined
                            ? `${(detail.report.usage.durationMs / 1000).toFixed(1)}s`
                            : detail.report.durationSeconds !== undefined
                              ? `${detail.report.durationSeconds.toFixed(1)}s`
                              : '—'}
                          {detail.report.usage.attemptsUsed
                            ? ` · ${detail.report.usage.attemptsUsed}x`
                            : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Reviewed Scope & Files Manifest */}
                {(detail.report.scopeManifest || detail.report.files.length > 0) && (
                  <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-xs space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-foreground">
                        {t('activity:chimeraReport.scopeHeading', {
                          defaultValue: 'Reviewed Scope',
                        })}
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                        {detail.report.scopeManifest?.headSha && (
                          <span className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-muted-foreground">
                            <GitCommit className="h-3 w-3" />
                            HEAD {detail.report.scopeManifest.headSha}
                          </span>
                        )}
                        {detail.report.scopeManifest?.isIncremental && (
                          <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-sans font-semibold text-primary">
                            {t('activity:chimeraReport.incrementalBadge', {
                              defaultValue: 'Incremental Delta',
                            })}
                          </span>
                        )}
                        {detail.scopeDrift && (
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-sans font-semibold border',
                              detail.scopeDrift.stale
                                ? 'border-warning/40 bg-warning/10 text-warning'
                                : 'border-success/30 bg-success/10 text-success',
                            )}
                            title={
                              detail.scopeDrift.stale
                                ? [
                                    ...detail.scopeDrift.modifiedPaths,
                                    ...detail.scopeDrift.missingPaths.map((p) => `${p} (missing)`),
                                  ].join(', ')
                                : undefined
                            }
                          >
                            {detail.scopeDrift.stale
                              ? t('activity:chimeraReport.scopeStaleBadge', {
                                  count:
                                    detail.scopeDrift.modifiedPaths.length +
                                    detail.scopeDrift.missingPaths.length,
                                  defaultValue: 'Stale on disk ({{count}} changed)',
                                })
                              : t('activity:chimeraReport.scopeCurrentBadge', {
                                  defaultValue: 'Current on disk ✓',
                                })}
                          </span>
                        )}
                      </div>
                    </div>

                    {detail.report.scopeManifest?.sessionIntent &&
                      detail.report.scopeManifest.sessionIntent.length > 0 && (
                        <div className="rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-[11px] space-y-1">
                          <span className="font-semibold text-muted-foreground block text-[10px] uppercase tracking-wider">
                            {t('activity:chimeraReport.sessionIntentLabel', {
                              defaultValue: 'Session intent',
                            })}
                          </span>
                          {detail.report.scopeManifest.sessionIntent.map((intent, idx) => (
                            <p key={idx} className="text-foreground/90 break-words">
                              • {intent}
                            </p>
                          ))}
                        </div>
                      )}

                    <div className="space-y-1.5">
                      {(detail.report.scopeManifest?.files ?? detail.report.files).map((f) => {
                        const sf = detail.report?.scopeManifest?.files.find(
                          (entry) => entry.path === f.path,
                        );
                        return (
                          <div
                            key={f.path}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-1.5"
                          >
                            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="font-mono text-[11px] font-medium text-foreground break-all">
                                {f.path}
                              </span>
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                                {f.status}
                              </span>
                              {sf?.isIncrementalDelta && (
                                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                  {t('activity:chimeraReport.deltaTag', { defaultValue: 'delta' })}
                                </span>
                              )}
                              {sf?.pairedTestPath && (
                                <span
                                  className={cn(
                                    'rounded px-1.5 py-0.5 text-[10px] font-medium border',
                                    sf.pairedTestUpdated
                                      ? 'border-success/30 bg-success/10 text-success'
                                      : 'border-warning/30 bg-warning/10 text-warning',
                                  )}
                                  title={sf.pairedTestPath}
                                >
                                  {sf.pairedTestUpdated
                                    ? t('activity:chimeraReport.pairedTestUpdated', {
                                        defaultValue: 'test updated ✓',
                                      })
                                    : t('activity:chimeraReport.pairedTestUntouched', {
                                        defaultValue: 'test untouched !',
                                      })}
                                </span>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                              {sf &&
                                (sf.addedLines !== undefined || sf.removedLines !== undefined) && (
                                  <span>
                                    <span className="text-success">+{sf.addedLines ?? 0}</span>{' '}
                                    <span className="text-destructive">
                                      -{sf.removedLines ?? 0}
                                    </span>
                                  </span>
                                )}
                              {sf?.changedSymbols && sf.changedSymbols.length > 0 && (
                                <span className="text-[10px] text-muted-foreground truncate max-w-xs">
                                  [{sf.changedSymbols.slice(0, 4).join(', ')}
                                  {sf.changedSymbols.length > 4 ? '…' : ''}]
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {detail.report.scopeManifest?.deletedFiles &&
                      detail.report.scopeManifest.deletedFiles.length > 0 && (
                        <div className="text-[11px] text-muted-foreground pt-1">
                          <span className="font-semibold text-destructive mr-1.5">
                            {t('activity:chimeraReport.deletedFilesLabel', {
                              defaultValue: 'Deleted in worktree:',
                            })}
                          </span>
                          <span className="font-mono">
                            {detail.report.scopeManifest.deletedFiles.join(', ')}
                          </span>
                        </div>
                      )}

                    {detail.report.scopeManifest?.deletedFileReferences &&
                      detail.report.scopeManifest.deletedFileReferences.length > 0 && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] space-y-1">
                          <span className="font-semibold text-destructive block">
                            {t('activity:chimeraReport.deletedFileRefsLabel', {
                              defaultValue: 'Dangling references to deleted files:',
                            })}
                          </span>
                          {detail.report.scopeManifest.deletedFileReferences.map((ref) => (
                            <div
                              key={ref.deletedPath}
                              className="font-mono text-destructive/90 break-all"
                            >
                              ⚠ {ref.deletedPath} → {ref.referencedBy.join(', ')}
                            </div>
                          ))}
                        </div>
                      )}

                    {detail.report.scopeManifest?.signatureCallers &&
                      detail.report.scopeManifest.signatureCallers.length > 0 && (
                        <div className="rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-[11px] space-y-1">
                          <span className="font-semibold text-muted-foreground block">
                            {t('activity:chimeraReport.signatureCallersLabel', {
                              defaultValue: 'External callers of modified exports:',
                            })}
                          </span>
                          {detail.report.scopeManifest.signatureCallers.map((entry) => (
                            <div
                              key={`${entry.file}:${entry.symbol}`}
                              className="font-mono text-foreground/90 break-all"
                            >
                              {entry.symbol} ({entry.file}) → {entry.callers.join(', ')}
                            </div>
                          ))}
                        </div>
                      )}

                    {detail.report.scopeManifest?.skippedFiles &&
                      detail.report.scopeManifest.skippedFiles.length > 0 && (
                        <div className="pt-1 border-t border-border/50">
                          <button
                            type="button"
                            onClick={() => setShowSkippedFiles((v) => !v)}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                          >
                            {showSkippedFiles ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                            {t('activity:chimeraReport.skippedFilesToggle', {
                              count: detail.report.scopeManifest.skippedFiles.length,
                              defaultValue: 'Skipped / Filtered Files ({{count}})',
                            })}
                          </button>
                          {showSkippedFiles && (
                            <div className="mt-1.5 space-y-1 pl-4 text-[11px]">
                              {detail.report.scopeManifest.skippedFiles.map((sk) => {
                                const reasonDef = SKIPPED_FILE_REASON_KEY[sk.reason];
                                const reasonLabel = reasonDef
                                  ? t(`activity:chimeraReport.${reasonDef.key}`, {
                                      defaultValue: reasonDef.fallback,
                                    })
                                  : sk.reason;
                                return (
                                  <div
                                    key={`${sk.path}:${sk.reason}`}
                                    className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground"
                                  >
                                    <span className="font-mono break-all">{sk.path}</span>
                                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                                      {reasonLabel}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                )}

                {/* Evidence Verification Block if any */}
                {detail.report.evidenceStatus && (
                  <div className="rounded-lg bg-muted/40 p-3 border border-border/80 text-xs space-y-2">
                    <div className="flex items-center gap-2 font-medium">
                      <span>Machine Evidence Verification:</span>
                      <span
                        className={cn(
                          'px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border',
                          detail.report.evidenceStatus === 'verified'
                            ? 'bg-success/10 text-success border-success/30'
                            : detail.report.evidenceStatus === 'failed'
                              ? 'bg-destructive/10 text-destructive border-destructive/30'
                              : 'bg-warning/10 text-warning border-warning/30',
                        )}
                      >
                        {detail.report.evidenceStatus}
                      </span>
                    </div>

                    {detail.report.evidenceChecks && detail.report.evidenceChecks.length > 0 && (
                      <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
                        {detail.report.evidenceChecks.map((chk, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span>{chk.ok ? '✓' : '✗'}</span>
                            <span className="font-semibold text-foreground">{chk.name}:</span>
                            <span className="truncate">{chk.command}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Action button to send prompt to session leader */}
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleSendToLeader}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Dispatch Follow-up Task to Session Leader
                  </button>
                </div>
              </div>

              {/* Findings List */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                    Findings ({detail.findings.length})
                  </h3>
                </div>

                {detail.findings.length === 0 ? (
                  <div className="rounded-xl border border-border/80 bg-card/40 p-8 text-center text-xs text-muted-foreground">
                    <CheckCircle2 className="mx-auto h-8 w-8 text-success/60 mb-2" />
                    No actionable findings were discovered in this review run.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {detail.findings.map(({ finding }) => {
                      const sev = SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS['low'];
                      return (
                        <div
                          key={finding.id}
                          className="rounded-xl border border-border bg-card p-4 space-y-3 shadow-sm transition-all hover:border-border/80"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold uppercase border',
                                  sev.bg,
                                  sev.text,
                                )}
                              >
                                <span className={cn('h-1.5 w-1.5 rounded-full', sev.dot)} />
                                {finding.severity}
                              </span>

                              {finding.category && (
                                <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                  {finding.category}
                                </span>
                              )}

                              {finding.location?.file && (
                                <span className="inline-flex items-center gap-1 font-mono text-xs text-foreground bg-muted/60 px-2 py-0.5 rounded">
                                  <FileCode2 className="h-3 w-3 text-muted-foreground" />
                                  {finding.location.file}
                                  {finding.location.line ? `:${finding.location.line}` : ''}
                                </span>
                              )}
                            </div>

                            {/* Finding Status and Actions */}
                            <div className="flex items-center gap-1.5 text-xs">
                              <span className="font-semibold text-muted-foreground mr-1">
                                Status:
                              </span>
                              <span
                                className={cn(
                                  'px-2 py-0.5 rounded-full text-[11px] font-medium capitalize border',
                                  finding.status === 'resolved'
                                    ? 'bg-success/10 text-success border-success/30'
                                    : finding.status === 'ignored'
                                      ? 'bg-muted text-muted-foreground border-border'
                                      : 'bg-primary/10 text-foreground border-primary/30',
                                )}
                              >
                                {finding.status}
                              </span>

                              {finding.status !== 'resolved' && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    transitionFinding(
                                      finding.id,
                                      'resolved',
                                      'fixed',
                                      'Resolved by operator in WebUI',
                                    )
                                  }
                                  className="ml-2 rounded px-2 py-0.5 text-[11px] font-medium bg-success/10 text-success hover:bg-success/20 border border-success/30"
                                >
                                  Resolve (Fixed)
                                </button>
                              )}
                              {finding.status !== 'ignored' && finding.status !== 'resolved' && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    transitionFinding(
                                      finding.id,
                                      'ignored',
                                      undefined,
                                      'Ignored by operator',
                                    )
                                  }
                                  className="rounded px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground hover:bg-muted/80 border border-border"
                                >
                                  Ignore
                                </button>
                              )}
                              {(finding.status === 'resolved' || finding.status === 'ignored') && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    transitionFinding(
                                      finding.id,
                                      'active',
                                      undefined,
                                      'Reopened in WebUI',
                                    )
                                  }
                                  className="rounded px-2 py-0.5 text-[11px] font-medium bg-primary/10 text-foreground hover:bg-primary/20 border border-primary/30"
                                >
                                  Reopen
                                </button>
                              )}
                            </div>
                          </div>

                          <h4 className="text-sm font-semibold text-foreground">{finding.title}</h4>
                          <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                            {finding.description}
                          </p>

                          {/* Suggested fix */}
                          {finding.suggestedFix && (
                            <div className="rounded-lg bg-muted/40 border border-border/80 p-3 space-y-1 text-xs">
                              <span className="font-semibold text-primary block">
                                Suggested Fix:
                              </span>
                              <pre className="font-mono text-[11px] text-foreground overflow-x-auto whitespace-pre-wrap">
                                {finding.suggestedFix}
                              </pre>
                            </div>
                          )}

                          {/* Verification status if attached */}
                          {finding.verification && (
                            <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                              <span>Disk check:</span>
                              <span
                                className={cn(
                                  'font-semibold',
                                  finding.verification.status === 'verified'
                                    ? 'text-success'
                                    : finding.verification.status === 'failed'
                                      ? 'text-destructive'
                                      : 'text-warning',
                                )}
                              >
                                {finding.verification.status} ({finding.verification.reason})
                              </span>
                              {finding.verification.evidence && (
                                <span className="font-mono text-muted-foreground truncate max-w-xs">
                                  "{finding.verification.evidence}"
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Raw Markdown Report Accordion */}
              {detail.report.rawText && (
                <div className="rounded-xl border border-border bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowRawText((s) => !s)}
                    className="flex w-full items-center justify-between px-4 py-3 text-xs font-semibold text-muted-foreground hover:bg-muted/50 transition-colors"
                  >
                    {t('activity:chimeraReport.rawReportMarkdown', {
                      defaultValue: 'Raw Report Markdown',
                    })}
                    {showRawText ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>
                  {showRawText && (
                    <div className="border-t border-border p-4 bg-muted/20">
                      <pre className="text-xs font-mono whitespace-pre-wrap break-words text-muted-foreground">
                        {detail.report.rawText}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right Area: Event Journal & Timeline */}
            <div className="w-full min-w-0 lg:w-80 border-t lg:border-t-0 lg:border-l border-border bg-card/30 shrink-0 lg:overflow-y-auto p-4 space-y-4">
              <div className="flex items-center gap-2 border-b border-border pb-3">
                <History className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-bold">Activity Journal</h3>
              </div>

              {/* Chronological Timeline */}
              <div className="space-y-3">
                {detail.events.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    No journal events recorded yet.
                  </p>
                ) : (
                  <div className="relative pl-4 space-y-4 before:absolute before:left-1.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-border">
                    {detail.events.map((ev) => (
                      <div key={ev.id} className="relative space-y-1 text-xs">
                        <div className="absolute -left-4 top-1 h-2 w-2 rounded-full bg-primary ring-4 ring-card" />
                        <div className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
                          <span className="font-semibold text-foreground capitalize">
                            {ev.eventType.replace('_', ' ')}
                          </span>
                          <span>{fmtRelative(ev.timestamp)}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Actor: <span className="font-medium text-foreground">{ev.actorId}</span> (
                          {ev.actorKind})
                        </div>
                        {ev.fromLifecycle && ev.toLifecycle && (
                          <div className="text-[11px] text-muted-foreground">
                            Status:{' '}
                            <span className="text-foreground">
                              {ev.fromLifecycle} ➔ {ev.toLifecycle}
                            </span>
                          </div>
                        )}
                        {ev.reason && (
                          <p className="rounded bg-muted/60 p-1.5 text-[11px] text-foreground/90 italic">
                            "{ev.reason}"
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Note / Inote Form */}
              <form onSubmit={handleAddNote} className="pt-3 border-t border-border space-y-2">
                <label
                  htmlFor="chimera-note-text"
                  className="text-xs font-semibold text-muted-foreground block"
                >
                  Add Journal Note / Inote:
                </label>
                <textarea
                  id="chimera-note-text"
                  rows={3}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder={t('activity:chimeraReport.notePlaceholder', {
                    defaultValue: 'Record an observation, fix PR link, or triage note...',
                  })}
                  className="w-full rounded-lg border border-border bg-background p-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  type="submit"
                  disabled={!noteText.trim()}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Append to Journal
                </button>
              </form>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading report details…
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <EmptyState
              icon={<ShieldAlert className="h-12 w-12 text-muted-foreground/40" />}
              title={t('activity:chimeraReport.selectReportTitle', {
                defaultValue: 'Select a Chimera Review Report',
              })}
              description="Choose a review report from the left pane to view structured findings, disk verification proofs, and the activity journal."
            />
          </div>
        )}
      </div>
    </div>
  );
}
