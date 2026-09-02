import {
  AlertCircle,
  AlertTriangle,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileCode2,
  FileText,
  Filter,
  History,
  Info,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Tag,
  User,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { chatLane, DEFAULT_LANE_ID } from '@/stores/chat-lanes';
import {
  useChimeraHubStore,
  type ChimeraReportSummaryItem,
  type FindingDetailItem,
} from '@/stores/chimera-hub-store';
import { useUIStore } from '@/stores/ui-store';
import { EmptyState } from './ui/empty-state';

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function fmtRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'Just now';
    if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
    if (diff < 604800_000) return `${Math.round(diff / 86400_000)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

const LIFECYCLE_BADGE: Record<string, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  open: { label: 'Open', cls: 'border-primary/30 bg-primary/10 text-primary', icon: AlertCircle },
  actioned: {
    label: 'Actioned',
    cls: 'border-warning/30 bg-warning/10 text-warning',
    icon: RotateCw,
  },
  completed: {
    label: 'Completed',
    cls: 'border-success/30 bg-success/10 text-success',
    icon: CheckCircle2,
  },
  skipped: { label: 'Skipped', cls: 'border-border bg-muted text-muted-foreground', icon: XCircle },
};

const SEVERITY_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  critical: {
    bg: 'bg-destructive/10 border-destructive/30',
    text: 'text-destructive',
    dot: 'bg-destructive',
  },
  high: { bg: 'bg-warning/15 border-warning/40', text: 'text-warning', dot: 'bg-warning' },
  medium: { bg: 'bg-warning/10 border-warning/30', text: 'text-warning', dot: 'bg-warning' },
  low: { bg: 'bg-muted border-border', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};

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
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* Top Header / Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/40 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="text-xl" aria-hidden>
            🦂
          </span>
          <div>
            <h1 className="text-base font-semibold leading-none">Chimera Review Hub & Journal</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Track agent code reviews, findings, session lineage, and audit event timeline
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Session filter */}
          <select
            value={filterSessionId}
            onChange={(e) => setFilterSessionId(e.target.value)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            aria-label="Filter by session"
          >
            <option value="">All Sessions ({sessionList.length})</option>
            {sessionList.map((sid) => (
              <option key={sid} value={sid}>
                Session: {sid.length > 16 ? `${sid.slice(0, 16)}…` : sid}
              </option>
            ))}
          </select>

          {/* Lifecycle filter */}
          <select
            value={filterLifecycle}
            onChange={(e) => setFilterLifecycle(e.target.value)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            aria-label="Filter by status"
          >
            <option value="">All Statuses</option>
            <option value="open">Open</option>
            <option value="actioned">Actioned</option>
            <option value="completed">Completed</option>
            <option value="skipped">Skipped</option>
          </select>

          {/* Search box */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search reports..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="rounded-lg border border-border bg-background pl-8 pr-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-40 sm:w-52"
            />
          </div>

          {/* Refresh button */}
          <button
            type="button"
            onClick={() => fetchReports()}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
            title="Refresh reports"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Main 3-column / Split View */}
      <div className="flex flex-1 min-h-0 min-w-0">
        {/* Left Pane: Reports List */}
        <div className="flex w-72 sm:w-80 flex-col border-r border-border bg-card/20 shrink-0 overflow-y-auto">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
            <span>Reports ({filteredReports.length})</span>
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>

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
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Middle & Right Pane: Report Detail, Findings & Journal */}
        {selectedReportId && detail?.report ? (
          <div className="flex flex-1 min-h-0 min-w-0 flex-col lg:flex-row overflow-hidden">
            {/* Center Area: Findings and Overview */}
            <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto p-4 sm:p-6 space-y-6">
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
                                      : 'bg-primary/10 text-primary border-primary/30',
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
                                  className="rounded px-2 py-0.5 text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/30"
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
                    <span>Raw Report Markdown</span>
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
            <div className="w-full lg:w-80 border-t lg:border-t-0 lg:border-l border-border bg-card/30 flex flex-col shrink-0 overflow-y-auto p-4 space-y-4">
              <div className="flex items-center gap-2 border-b border-border pb-3">
                <History className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-bold">Activity Journal</h3>
              </div>

              {/* Chronological Timeline */}
              <div className="space-y-3 flex-1 overflow-y-auto">
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
                <label className="text-xs font-semibold text-muted-foreground block">
                  Add Journal Note / Inote:
                </label>
                <textarea
                  rows={3}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Record an observation, fix PR link, or triage note..."
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
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <EmptyState
              icon={<ShieldAlert className="h-12 w-12 text-muted-foreground/40" />}
              title="Select a Chimera Review Report"
              description="Choose a review report from the left pane to view structured findings, disk verification proofs, and the activity journal."
            />
          </div>
        )}
      </div>
    </div>
  );
}
