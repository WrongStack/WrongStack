/**
 * TechStackView — cross-language dependency intelligence for the open project.
 *
 * Answers four questions about the active workdir, in one place: what is here,
 * what is out of date, what is vulnerable, and what should be done about it.
 *
 * Data flow (unchanged from the original design, and worth preserving):
 * commands go out over REST, progress comes back over the WebSocket into
 * `useTechStackStore`.
 *
 * - `Refresh`  → POST /api/techstack/inventory — offline, manifests + lockfiles
 * - `Analyze`  → POST /api/techstack/analyze   — + registries, OSV, and LLM research
 * - Deep dive  → POST /api/techstack/deps/:id/research — one package, on demand
 *
 * @see docs/specs/techstack-sdd.md §4.2, §6
 */

import {
  Boxes,
  Download,
  FileCode,
  FileText,
  Loader2,
  RefreshCw,
  Shield,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  type TechStackDependency,
  type TechStackFinding,
  type TechStackSnapshot,
  useTechStackStore,
} from '@/stores';
import { DependencyDetail } from './DependencyDetail';
import { DependencyTable } from './DependencyTable';
import { FindingsPanel } from './FindingsPanel';
import {
  COVERAGE_META,
  downloadReport,
  ECOSYSTEM_META,
  EcosystemIcon,
  ecosystemLabel,
  MetricCard,
  needsAttention,
  statusMeta,
  versionDrift,
} from './shared';
import { type DependencySort, TechStackToolbar } from './TechStackToolbar';
import { useAppTranslation } from '@/i18n';

interface SnapshotResponse {
  snapshot: TechStackSnapshot | null;
  stale: boolean;
}

type MainTab = 'dependencies' | 'findings' | 'workspaces' | 'trends' | 'remediation';

interface TechStackTrend {
  snapshots: number;
  vulnerabilityHalfLifeMs?: number;
  points: ReadonlyArray<{
    snapshotId: string;
    createdAt: string;
    dependencies: number;
    outdated: number;
    vulnerable: number;
  }>;
  dependencies: ReadonlyArray<{
    key: string;
    name: string;
    ecosystem: string;
    currentVersion?: string;
    lockedVersionAgeMs: number;
    versionChanges: number;
  }>;
}

interface RemediationPlan {
  warning: string;
  summary: {
    total: number;
    patch: number;
    minor: number;
    major: number;
    replace: number;
    remove: number;
    investigate: number;
  };
  items: ReadonlyArray<{
    workspaceId: string;
    dependencyName: string;
    ecosystem: string;
    action: string;
    severity: string;
    currentVersion?: string;
    targetVersion?: string;
    rationale: string;
  }>;
}

const TABS: ReadonlyArray<{ id: MainTab; labelKey: string }> = [
  { id: 'dependencies', labelKey: 'activity:techStack.tabDependencies' },
  { id: 'findings', labelKey: 'activity:techStack.tabFindings' },
  { id: 'workspaces', labelKey: 'activity:techStack.tabWorkspaces' },
  { id: 'trends', labelKey: 'activity:techStack.tabTrends' },
  { id: 'remediation', labelKey: 'activity:techStack.tabRemediation' },
];

/**
 * Ecosystems the backend can auto-execute upgrades for.
 *
 * Mirrors `EXECUTABLE_ECOSYSTEMS` in `packages/techstack/src/remediation.ts`.
 * When adding a new ecosystem to that set, add it here too so the UI
 * unblocks its auto-apply checkbox in the Remediation tab.
 */
const AUTOMATED_REMEDIATION_ECOSYSTEMS = new Set(['npm', 'python', 'rust', 'go', 'php', 'dotnet']);

export function TechStackView() {
  const { t } = useAppTranslation();
  const snapshot = useTechStackStore((state) => state.snapshot);
  const stale = useTechStackStore((state) => state.stale);
  const loading = useTechStackStore((state) => state.loading);
  const error = useTechStackStore((state) => state.error);
  const activeJob = useTechStackStore((state) => state.activeJob);

  const [tab, setTab] = useState<MainTab>('dependencies');
  const [searchQuery, setSearchQuery] = useState('');
  const [ecosystemFilter, setEcosystemFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [directOnly, setDirectOnly] = useState(false);
  const [sort, setSort] = useState<DependencySort>('attention');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deepDiveFindings, setDeepDiveFindings] = useState<readonly TechStackFinding[]>([]);
  const [deepDive, setDeepDive] = useState<{
    status: 'idle' | 'loading' | 'error';
    error: string | null;
  }>({ status: 'idle', error: null });
  const [trend, setTrend] = useState<TechStackTrend | null>(null);
  const [remediation, setRemediation] = useState<RemediationPlan | null>(null);
  const [approvedDependencies, setApprovedDependencies] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  // ── Data ────────────────────────────────────────────────────────────────

  const fetchSnapshot = useCallback(async () => {
    const store = useTechStackStore.getState();
    store.setLoading(true);
    store.setError(null);
    try {
      const response = await fetch('/api/techstack/snapshot');
      if (response.status === 404) {
        store.setSnapshot(null, false);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const data = (await response.json()) as SnapshotResponse;
      store.setSnapshot(data.snapshot, data.stale);
    } catch (cause) {
      store.setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const startJob = useCallback(async (kind: 'inventory' | 'analyze') => {
    const store = useTechStackStore.getState();
    store.setLoading(true);
    store.setError(null);
    try {
      const response = await fetch(`/api/techstack/${kind}`, { method: 'POST' });
      const body = (await response.json()) as { jobId?: string; error?: string };
      if (!response.ok || !body.jobId) {
        throw new Error(body.error ?? `HTTP ${response.status}: ${response.statusText}`);
      }
      store.jobStarted(body.jobId, kind);
    } catch (cause) {
      store.setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const cancelJob = useCallback(async () => {
    const job = useTechStackStore.getState().activeJob;
    if (!job) return;
    try {
      const response = await fetch(`/api/techstack/jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      useTechStackStore.getState().jobCancelled(job.id);
    } catch (cause) {
      useTechStackStore.getState().setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const runDeepDive = useCallback(async (dependency: TechStackDependency) => {
    setDeepDive({ status: 'loading', error: null });
    try {
      const response = await fetch(
        `/api/techstack/deps/${encodeURIComponent(dependency.id)}/research`,
        { method: 'POST' },
      );
      const body = (await response.json()) as {
        findings?: TechStackFinding[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setDeepDiveFindings(body.findings ?? []);
      setDeepDive({ status: 'idle', error: null });
    } catch (cause) {
      setDeepDive({
        status: 'error',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot();
  }, [fetchSnapshot]);

  useEffect(() => {
    if (tab !== 'trends' && tab !== 'remediation') return;
    const endpoint = tab === 'trends' ? 'trends' : 'remediation';
    void fetch(`/api/techstack/${endpoint}`)
      .then(async (response) => {
        const body = (await response.json()) as {
          trend?: TechStackTrend;
          plan?: RemediationPlan;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (body.trend) setTrend(body.trend);
        if (body.plan) setRemediation(body.plan);
      })
      .catch((cause) =>
        useTechStackStore
          .getState()
          .setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [tab, snapshot?.id]);

  const applyRemediation = useCallback(async () => {
    if (approvedDependencies.size === 0) return;
    setApplying(true);
    try {
      const response = await fetch('/api/techstack/remediation/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedItems: [...approvedDependencies] }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setApprovedDependencies(new Set());
      await startJob('inventory');
    } catch (cause) {
      useTechStackStore.getState().setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplying(false);
    }
  }, [approvedDependencies, startJob]);

  // A new snapshot invalidates the ad-hoc deep-dive results — they were about
  // versions that may no longer be installed.
  useEffect(() => {
    setDeepDiveFindings([]);
    setDeepDive({ status: 'idle', error: null });
  }, [snapshot?.id]);

  // ── Derived ─────────────────────────────────────────────────────────────

  const dependencies = useMemo(() => snapshot?.dependencies ?? [], [snapshot]);
  const findings = useMemo(() => snapshot?.findings ?? [], [snapshot]);

  const dependenciesById = useMemo(
    () => new Map(dependencies.map((dep) => [dep.id, dep])),
    [dependencies],
  );

  const ecosystems = useMemo(() => tally(dependencies.map((dep) => dep.ecosystem)), [dependencies]);
  const statuses = useMemo(() => tally(dependencies.map((dep) => dep.status)), [dependencies]);

  const coverageByWorkspaceId = useMemo(
    () => new Map(snapshot?.workspaces.map((w) => [w.id, w.coverage]) ?? []),
    [snapshot],
  );

  const visible = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = dependencies.filter((dep) => {
      if (query && !dep.name.toLowerCase().includes(query)) return false;
      if (ecosystemFilter !== 'all' && dep.ecosystem !== ecosystemFilter) return false;
      if (statusFilter !== 'all' && dep.status !== statusFilter) return false;
      if (directOnly && !dep.direct) return false;
      return true;
    });

    const sorted = [...filtered];
    if (sort === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === 'drift') {
      sorted.sort(
        (a, b) =>
          versionDrift(b).majorsBehind - versionDrift(a).majorsBehind ||
          a.name.localeCompare(b.name),
      );
    } else {
      sorted.sort(
        (a, b) =>
          statusMeta(b.status).weight - statusMeta(a.status).weight ||
          Number(b.direct) - Number(a.direct) ||
          a.name.localeCompare(b.name),
      );
    }
    return sorted;
  }, [dependencies, searchQuery, ecosystemFilter, statusFilter, directOnly, sort]);

  const selected = selectedId ? dependenciesById.get(selectedId) : undefined;

  const selectedFindings = useMemo(() => {
    if (!selected) return [];
    return [
      ...findings.filter((f) => f.dependencyId === selected.id),
      ...deepDiveFindings.filter((f) => f.dependencyId === selected.id),
    ];
  }, [findings, deepDiveFindings, selected]);

  const attentionCount = useMemo(() => dependencies.filter(needsAttention).length, [dependencies]);
  const outdatedCount = useMemo(
    () => dependencies.filter((dep) => versionDrift(dep).majorsBehind > 0).length,
    [dependencies],
  );
  const vulnerableCount = useMemo(
    () => dependencies.filter((dep) => dep.status === 'vulnerable').length,
    [dependencies],
  );

  const hasFilters =
    searchQuery.trim() !== '' || ecosystemFilter !== 'all' || statusFilter !== 'all' || directOnly;

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setEcosystemFilter('all');
    setStatusFilter('all');
    setDirectOnly(false);
  }, []);

  const jobRunning = Boolean(
    activeJob && !['completed', 'failed', 'cancelled'].includes(activeJob.status),
  );

  const selectDependencyById = useCallback((dependencyId: string) => {
    setSelectedId(dependencyId);
    setTab('dependencies');
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/70 px-4 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-bold sm:text-lg">
                {t('activity:techStack.techstack')}
              </h1>
              <span className="border border-info/35 bg-info/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase text-info">
                {snapshot ? `${snapshot.workspaces.length} workspaces` : 'no scan yet'}
              </span>
              {stale && (
                <span className="border border-warning/35 bg-warning/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase text-warning">
                  {t('activity:techStack.staleGt24h')}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground sm:text-xs">
              {snapshot
                ? `${snapshot.targetRoot} · scanned ${new Date(snapshot.createdAt).toLocaleString()}`
                : 'Scan the open project to inventory its dependencies.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void startJob('inventory')}
              disabled={jobRunning}
              title={t('activity:techStack.offlineReReadManifestsAndLockfiles')}
            >
              <RefreshCw className={cn('size-3.5', jobRunning && 'animate-spin')} />
              <span className="hidden sm:inline">{t('activity:techStack.refresh')}</span>
            </Button>
            <Button
              size="sm"
              onClick={() => void startJob('analyze')}
              disabled={jobRunning}
              title={t(
                'activity:techStack.checkRegistriesAndAdvisoriesThenInterpretTheResultsWithTheModel',
              )}
            >
              <Sparkles className="size-3.5" />
              {t('activity:techStack.analyze')}
            </Button>
            {jobRunning && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void cancelJob()}
                aria-label={t('activity:techStack.cancelJob')}
              >
                <X className="size-4" />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!snapshot}
                  aria-label={t('activity:techStack.exportOptions')}
                  title={t('activity:techStack.exportOptions')}
                >
                  <Download className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onClick={() => snapshot && downloadReport(snapshot, 'json')}>
                  <FileCode className="mr-2 size-4" />
                  {t('activity:techStack.exportSnapshotAsJson')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => snapshot && downloadReport(snapshot, 'spdx')}>
                  <Shield className="mr-2 size-4" />
                  {t('activity:techStack.exportSbomSpdx')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => snapshot && downloadReport(snapshot, 'cyclonedx')}>
                  <ShieldCheck className="mr-2 size-4" />
                  {t('activity:techStack.exportSbomCycloneDx')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => snapshot && downloadReport(snapshot, 'md')}>
                  <FileText className="mr-2 size-4" />
                  {t('activity:techStack.exportReportMd')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Metrics */}
      {snapshot && (
        <div className="grid shrink-0 grid-cols-2 gap-px border-b border-border/70 bg-border/60 sm:grid-cols-4">
          <MetricCard
            label={t('activity:techStack.dependencies')}
            value={dependencies.length}
            hint={`${visible.length} visible`}
          />
          <MetricCard
            label={t('activity:techStack.outdated')}
            value={outdatedCount}
            hint={t('activity:techStack.majorsBehind')}
            tone={outdatedCount > 0 ? 'warning' : 'success'}
          />
          <MetricCard
            label={t('activity:techStack.vulnerable')}
            value={vulnerableCount}
            hint={t('activity:techStack.knownAdvisories')}
            tone={vulnerableCount > 0 ? 'destructive' : 'success'}
          />
          <MetricCard
            label={t('activity:techStack.findings')}
            value={findings.length}
            hint={`${attentionCount} need attention`}
            tone={findings.length > 0 ? 'info' : 'default'}
          />
        </div>
      )}

      {/* Status band */}
      {(jobRunning || error) && (
        <div className="shrink-0 border-b border-border/70 px-4 py-2" aria-live="polite">
          {jobRunning && activeJob && (
            <div role="status" className="flex items-center gap-2 text-xs text-info">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="font-mono">{activeJob.status}</span>
              {activeJob.progress && (
                <span className="text-muted-foreground">
                  {activeJob.progress.completed}/{activeJob.progress.total}
                </span>
              )}
            </div>
          )}
          {error && (
            <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
              <span className="min-w-0 flex-1 truncate">{error}</span>
              <button type="button" onClick={() => void fetchSnapshot()} className="underline">
                {t('activity:techStack.retry')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Body */}
      {loading && !snapshot ? (
        <LoadingState />
      ) : !snapshot ? (
        <EmptyState onScan={() => void startJob('inventory')} disabled={jobRunning} />
      ) : (
        <>
          <nav className="flex shrink-0 gap-1 border-b border-border/70 px-2">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                aria-current={tab === entry.id}
                className={cn(
                  'border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                  tab === entry.id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(entry.labelKey)}
                {entry.id === 'findings' && findings.length > 0 && (
                  <span className="ml-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {findings.length}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {tab === 'dependencies' && (
            <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(340px,1fr)_minmax(0,1.15fr)]">
              <section
                className={cn(
                  'min-h-0 border-r border-border/70',
                  selected ? 'hidden md:flex md:flex-col' : 'flex flex-col',
                )}
                aria-label={t('activity:techStack.dependencyList')}
              >
                <TechStackToolbar
                  searchQuery={searchQuery}
                  ecosystemFilter={ecosystemFilter}
                  statusFilter={statusFilter}
                  directOnly={directOnly}
                  sort={sort}
                  hasFilters={hasFilters}
                  ecosystems={ecosystems}
                  statuses={statuses}
                  visibleCount={visible.length}
                  totalCount={dependencies.length}
                  onSearchChange={setSearchQuery}
                  onEcosystemFilterChange={setEcosystemFilter}
                  onStatusFilterChange={setStatusFilter}
                  onToggleDirectOnly={() => setDirectOnly((value) => !value)}
                  onSortChange={setSort}
                  onClearFilters={clearFilters}
                />
                <DependencyTable
                  dependencies={visible}
                  selectedId={selectedId}
                  hasDependencies={dependencies.length > 0}
                  coverageByWorkspaceId={coverageByWorkspaceId}
                  onSelect={(dep) => setSelectedId(dep.id)}
                />
              </section>
              <section
                className={cn('min-h-0', selected ? 'flex flex-col' : 'hidden md:flex md:flex-col')}
                aria-label={t('activity:techStack.dependencyDetail')}
              >
                {selected ? (
                  <DependencyDetail
                    dependency={selected}
                    findings={selectedFindings}
                    deepDive={deepDive}
                    onDeepDive={runDeepDive}
                    onBack={() => setSelectedId(null)}
                    coverage={coverageByWorkspaceId.get(selected.workspaceId)}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center p-8 text-center">
                    <p className="max-w-xs text-xs text-muted-foreground">
                      {t('activity:techStack.selectADependencyToSeeIts')}
                    </p>
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === 'findings' && (
            <FindingsPanel
              findings={findings}
              dependenciesById={dependenciesById}
              onSelectDependency={selectDependencyById}
            />
          )}

          {tab === 'workspaces' && <WorkspaceList snapshot={snapshot} />}
          {tab === 'trends' && <TrendPanel trend={trend} />}
          {tab === 'remediation' && (
            <RemediationPanel
              plan={remediation}
              approved={approvedDependencies}
              applying={applying}
              onToggle={(key) =>
                setApprovedDependencies((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              onApply={() => void applyRemediation()}
            />
          )}
        </>
      )}
    </div>
  );
}

function TrendPanel({ trend }: { trend: TechStackTrend | null }) {
  if (!trend) return <LoadingState />;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <p className="mb-3 text-xs text-muted-foreground">
        {trend.snapshots} snapshots
        {trend.vulnerabilityHalfLifeMs !== undefined
          ? ` · vulnerability half-life ${(trend.vulnerabilityHalfLifeMs / 86_400_000).toFixed(1)} days`
          : ''}
      </p>
      <div className="flex flex-col gap-1.5">
        {trend.points.map((point) => (
          <div
            key={point.snapshotId}
            className="grid grid-cols-4 border border-border/70 bg-card/40 p-2 text-xs"
          >
            <span>{new Date(point.createdAt).toLocaleDateString()}</span>
            <span>{point.dependencies} deps</span>
            <span className="text-warning">{point.outdated} outdated</span>
            <span className="text-destructive">{point.vulnerable} vulnerable</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RemediationPanel({
  plan,
  approved,
  applying,
  onToggle,
  onApply,
}: {
  plan: RemediationPlan | null;
  approved: ReadonlySet<string>;
  applying: boolean;
  onToggle: (name: string) => void;
  onApply: () => void;
}) {
  const { t } = useAppTranslation();
  if (!plan) return <LoadingState />;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{plan.warning}</p>
        <Button size="sm" disabled={approved.size === 0 || applying} onClick={onApply}>
          {applying && <Loader2 className="size-3.5 animate-spin" />}
          Apply {approved.size > 0 ? approved.size : ''}
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {plan.items.map((item) => {
          const key = `${item.workspaceId}:${item.ecosystem}:${item.dependencyName}:${item.action}`;
          const manual =
            item.action === 'replace' ||
            item.action === 'investigate' ||
            !AUTOMATED_REMEDIATION_ECOSYSTEMS.has(item.ecosystem);
          return (
            <label
              key={key}
              className={cn(
                'flex gap-3 border border-border/70 bg-card/40 p-2.5',
                manual ? 'cursor-not-allowed opacity-65' : 'cursor-pointer',
              )}
            >
              <input
                type="checkbox"
                disabled={manual}
                checked={approved.has(key)}
                onChange={() => onToggle(key)}
              />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs">
                  {item.dependencyName} · {item.action}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  {item.currentVersion ?? '?'} → {item.targetVersion ?? 'latest'} · {item.rationale}
                </span>
                {manual && (
                  <span className="block text-[10px] text-warning">
                    {t('activity:techStack.requiresAManualPackageChoice')}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {plan.items.length === 0 && (
          <p className="p-8 text-center text-xs text-muted-foreground">
            {t('activity:techStack.noRemediationNeeded')}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Workspaces ────────────────────────────────────────────────────────────

function WorkspaceList({ snapshot }: { snapshot: TechStackSnapshot }) {
  const { t } = useAppTranslation();
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const dep of snapshot.dependencies) {
      map.set(dep.workspaceId, (map.get(dep.workspaceId) ?? 0) + 1);
    }
    return map;
  }, [snapshot]);
  // Workspaces are bounded (per project), show all without pagination.

  if (snapshot.workspaces.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-xs text-muted-foreground">
          {t('activity:techStack.noWorkspacesDetected')}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="flex flex-col gap-1.5">
        {snapshot.workspaces.map((workspace) => {
          const coverage = COVERAGE_META[workspace.coverage];
          return (
            <div key={workspace.id} className="border border-border/70 bg-card/40 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-foreground">
                    {workspace.relativeRoot}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                    <EcosystemIcon ecosystem={workspace.ecosystem} />
                    <span>{ecosystemLabel(workspace.ecosystem, t)}</span>
                    {workspace.packageManager ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{workspace.packageManager}</span>
                      </>
                    ) : null}
                    <span aria-hidden="true">·</span>
                    <span>{counts.get(workspace.id) ?? 0} deps</span>
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 border px-1.5 py-0.5 text-[10px] font-medium',
                    coverage.badge,
                  )}
                >
                  {t(coverage.labelKey)}
                </span>
              </div>
              {workspace.manifests.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {workspace.manifests.map((manifest) => (
                    <span
                      key={manifest}
                      className="border border-border/70 bg-background/45 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
                    >
                      {manifest.split(/[/\\]/).pop()}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── States ────────────────────────────────────────────────────────────────

function LoadingState() {
  const { t } = useAppTranslation();
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex flex-col items-center gap-2">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {t('activity:techStack.loadingSnapshot')}
        </span>
      </div>
    </div>
  );
}

function EmptyState({ onScan, disabled }: { onScan: () => void; disabled: boolean }) {
  const { t } = useAppTranslation();
  const ecosystemList = useMemo(
    () =>
      Object.values(ECOSYSTEM_META)
        .map((meta) => meta.label ?? '')
        .filter(Boolean)
        .join(', '),
    [],
  );

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center border border-info/25 bg-info/5 text-info">
          <Boxes className="size-6" />
        </div>
        <h2 className="text-sm font-semibold">{t('activity:techStack.noInventoryYet')}</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          TechStack reads every manifest and lockfile in the open project — {ecosystemList} — and
          compares what you have against the upstream registries.
        </p>
        <Button size="sm" onClick={onScan} disabled={disabled}>
          <RefreshCw className={cn('size-3.5', disabled && 'animate-spin')} />
          {t('activity:techStack.scanThisProject')}
        </Button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Count occurrences, ordered by frequency then name. */
function tally(values: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
