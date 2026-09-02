import { ArrowRight, Crosshair, Gauge, KeyRound, Loader2, ShieldOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation } from '@/i18n';
import { buildBugHuntMessage } from '@/lib/bug-hunt-message';
import { launchBuiltinRound } from '@/lib/launch-builtin-round';
import {
  buildPerfRunMessage,
  PERF_MODE_SLUGS,
  PERF_MUTATING_MODES,
  PERF_RUN_METRIC_LABELS,
  PERF_RUN_METRICS,
  PERF_RUN_MODE_LABELS,
  PERF_RUN_MODES,
  type PerfRunMetric,
  type PerfRunMode,
} from '@/lib/perf-run-message';
import { cn } from '@/lib/utils';
import { openMainView } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore, useFileStore, useSessionStore } from '@/stores';
import type { TreeNode } from '@/stores/file-store';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';

const ELITE_BUG_HUNTER_SLUG = 'elite-bug-hunter';

function directoryPaths(tree: TreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'directory') continue;
      // The server already prunes project-root `.gitignore` matches from the
      // tree, but it also stamps `ignored: true` on any node that survives
      // pruning so the WebUI can stay defensive across server versions.
      // The Bug Hunter scope dropdown is the place where gitignored
      // directories are most visible — every `.gitignore`'d build/cache
      // dir would otherwise crowd out the directories the user actually
      // wants to scan.
      if (node.ignored) continue;
      paths.push(node.path);
      if (node.children) visit(node.children);
    }
  };
  visit(tree);
  return paths.sort((a, b) => a.localeCompare(b));
}

export function WelcomeScreen() {
  const { t } = useAppTranslation();
  const { projectName, cwd } = useSessionStore(
    useShallow((s) => ({ projectName: s.projectName, cwd: s.cwd })),
  );
  const { provider, model } = useConfigStore(
    useShallow((s) => ({ provider: s.provider, model: s.model })),
  );
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const projectTree = useFileStore((s) => s.tree);
  const sessionId = useSessionStore((s) => s.session?.id);
  const { subagentsAllowed, setPrefs } = useLocalPrefs(
    useShallow((s) => ({ subagentsAllowed: s.subagentsAllowed, setPrefs: s.set })),
  );
  const { addMessage, setLoading } = useChatStore(
    useShallow((s) => ({ addMessage: s.addMessage, setLoading: s.setLoading })),
  );
  const [savedCount, setSavedCount] = useState<number | undefined>(undefined);
  const [bugHuntState, setBugHuntState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [bugHuntScope, setBugHuntScope] = useState('');
  const [bugHuntMaxBugs, setBugHuntMaxBugs] = useState<1 | 2 | 3>(1);
  const [perfState, setPerfState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [perfScope, setPerfScope] = useState('');
  const [perfMode, setPerfMode] = useState<PerfRunMode>('ratchet');
  const [perfMetric, setPerfMetric] = useState<PerfRunMetric | ''>('');
  const scopeDirectories = directoryPaths(projectTree);
  useEffect(() => {
    if (!wsConnected) return;
    const client = getWSClient(wsUrl);
    const off = client.on('providers.saved', (msg: WSServerMessage) => {
      const p = msg.payload as { providers: unknown[] };
      setSavedCount(p.providers?.length ?? 0);
    });
    client.listSavedProviders();
    return () => {
      off();
    };
  }, [wsConnected, wsUrl]);

  useEffect(() => {
    if (!wsConnected) return;
    getWSClient(wsUrl).send({
      type: 'files.tree',
      payload: sessionId ? { sessionId } : {},
    });
  }, [sessionId, wsConnected, wsUrl]);

  const startBugHunt = useCallback(() => {
    const client = getWSClient(wsUrl);
    if (!client.isConnected || bugHuntState === 'loading') return;
    setBugHuntState('loading');

    launchBuiltinRound({
      client,
      slug: ELITE_BUG_HUNTER_SLUG,
      requireSoloSession: true,
      subagentsAllowed,
      sessionId,
      setPrefs,
      compose: (content) => {
        const scopeText = bugHuntScope
          ? `${bugHuntScope} and all of its descendants`
          : 'the whole project';
        return buildBugHuntMessage(
          `${content}

## WebUI run configuration (mandatory)
This run may complete up to ${bugHuntMaxBugs} proven bug ${bugHuntMaxBugs === 1 ? 'round' : 'rounds'}. Work on only one bug at a time; after its proof, fix, verification, and cleanup are complete, continue to the next round only while below this limit. Stop early when no further proven bug is available. Stay strictly within ${scopeText}. This configuration overrides the prompt's one-issue total limit, but not its one-issue-per-round discipline.`,
          { scope: bugHuntScope, maxBugs: bugHuntMaxBugs },
        );
      },
      onSent: (id, content) => {
        addMessage({
          id,
          role: 'user',
          content,
          bugHunt: { scope: bugHuntScope, maxBugs: bugHuntMaxBugs },
        });
        setLoading(true);
      },
      onSettle: setBugHuntState,
    });
  }, [
    addMessage,
    bugHuntMaxBugs,
    bugHuntScope,
    bugHuntState,
    sessionId,
    setLoading,
    setPrefs,
    subagentsAllowed,
    wsUrl,
  ]);

  const startPerfRun = useCallback(() => {
    const client = getWSClient(wsUrl);
    if (!client.isConnected || perfState === 'loading') return;
    setPerfState('loading');

    launchBuiltinRound({
      client,
      slug: PERF_MODE_SLUGS[perfMode],
      // Only the modes that may edit production code force a solo session; an
      // audit or a triage is read-only and has no attribution to protect.
      requireSoloSession: PERF_MUTATING_MODES.has(perfMode),
      subagentsAllowed,
      sessionId,
      setPrefs,
      compose: (content) => {
        const scopeText = perfScope
          ? `${perfScope} and all of its descendants`
          : 'the whole project';
        const metricLine = perfMetric
          ? `Optimise for ${PERF_RUN_METRIC_LABELS[perfMetric]} (\`${perfMetric}\`). A change that improves another metric while making this one worse is a regression for this round.`
          : 'Pick the metric the user actually feels for this workload, name it explicitly, and state why it is the one that matters before you measure anything.';
        return buildPerfRunMessage(
          `${content}

## WebUI run configuration (mandatory)
Stay strictly within ${scopeText}. ${metricLine}
Record the baseline, every attempt, and every keep/revert verdict in \`PERF_LOG.md\` as you go — a result that is not in the ledger did not happen.`,
          { scope: perfScope, mode: perfMode, metric: perfMetric },
        );
      },
      onSent: (id, content) => {
        addMessage({
          id,
          role: 'user',
          content,
          perfRun: { scope: perfScope, mode: perfMode, metric: perfMetric },
        });
        setLoading(true);
      },
      onSettle: setPerfState,
    });
  }, [
    addMessage,
    perfMetric,
    perfMode,
    perfScope,
    perfState,
    sessionId,
    setLoading,
    setPrefs,
    subagentsAllowed,
    wsUrl,
  ]);

  const toggleSoloSession = useCallback(() => {
    const allowed = !subagentsAllowed;
    setPrefs({ subagentsAllowed: allowed });
    getWSClient(wsUrl).send({
      type: 'prefs.update',
      payload: { subagentsAllowed: allowed, ...(sessionId ? { sessionId } : {}) },
    });
  }, [sessionId, setPrefs, subagentsAllowed, wsUrl]);

  return (
    <div className="flex flex-col gap-5 py-5 sm:py-7 max-w-6xl mx-auto w-full">
      {/* ── Session start panel ── */}
      <div className="ws-surface relative overflow-hidden rounded-xl p-5 sm:p-6">
        {/* Decorative gradient blob — subtle visual depth */}
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-gradient-to-br from-primary/8 via-primary/5 to-transparent blur-3xl pointer-events-none" />
        <div className="absolute -bottom-12 -left-12 w-48 h-48 rounded-full bg-gradient-to-tr from-accent/8 to-transparent blur-3xl pointer-events-none" />

        <div className="relative flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src="/wrongstack.svg"
              alt="WrongStack"
              draggable={false}
              className="ws-brand-logo h-16 w-16 shrink-0 border border-border/70 shadow-sm shadow-primary/20 sm:h-20 sm:w-20"
            />
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight">
                {projectName
                  ? t('setup:welcome.heroTitleInProject', { name: projectName })
                  : t('setup:welcome.heroTitle')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                {t('setup:welcome.heroSubtitle')}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-[76px] sm:pl-[92px]">
            {provider && model && (
              <p className="truncate text-xs text-muted-foreground/80 font-mono">
                {provider} / {model}
              </p>
            )}
            {cwd && (
              <p className="truncate text-[11px] text-muted-foreground/75 font-mono" title={cwd}>
                {t('setup:welcome.workingDirectory', { cwd })}
              </p>
            )}
          </div>
          <div className="mt-2 border-t border-border/70 pt-4">
            <button
              type="button"
              role="switch"
              aria-checked={!subagentsAllowed}
              onClick={toggleSoloSession}
              disabled={!wsConnected}
              className={cn(
                'mb-3 flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors',
                !subagentsAllowed
                  ? 'border-warning/45 bg-warning/10'
                  : 'border-border/70 bg-background/35 hover:bg-muted/45',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <ShieldOff className="h-5 w-5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">
                  {t('setup:welcome.soloSessionTitle')}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t('setup:welcome.soloSessionBody')}
                </span>
              </span>
              <span className="text-xs font-semibold uppercase">
                {!subagentsAllowed ? t('setup:welcome.on') : t('setup:welcome.off')}
              </span>
            </button>
            <div className="rounded-md border border-primary/35 bg-primary/8 p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                  {bugHuntState === 'loading' ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Crosshair className="h-5 w-5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {t('setup:welcome.bugHunterTitle')}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {t('setup:welcome.bugHunterBody')}
                  </span>
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
                <label className="sr-only" htmlFor="bug-hunt-scope">
                  {t('setup:welcome.bugHunterScope')}
                </label>
                <select
                  id="bug-hunt-scope"
                  value={bugHuntScope}
                  onChange={(event) => setBugHuntScope(event.target.value)}
                  disabled={!wsConnected || bugHuntState === 'loading'}
                  className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t('setup:welcome.bugHunterWholeProject')}</option>
                  {scopeDirectories.map((path) => (
                    <option key={path} value={path}>
                      {t('setup:welcome.bugHunterDirectoryScope', { path })}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
                  <span className="whitespace-nowrap text-muted-foreground">
                    {t('setup:welcome.bugHunterMaxBugs')}
                  </span>
                  <select
                    aria-label={t('setup:welcome.bugHunterMaxBugs')}
                    value={bugHuntMaxBugs}
                    onChange={(event) => setBugHuntMaxBugs(Number(event.target.value) as 1 | 2 | 3)}
                    disabled={!wsConnected || bugHuntState === 'loading'}
                    className="min-w-0 bg-transparent font-semibold outline-none"
                  >
                    {[1, 2, 3].map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={startBugHunt}
                  disabled={!wsConnected || savedCount === 0 || bugHuntState === 'loading'}
                  className="group flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('setup:welcome.bugHunterStart')}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </button>
              </div>
            </div>
            {bugHuntState === 'error' && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {t('setup:welcome.bugHunterError')}
              </p>
            )}
            <div className="mt-3 rounded-md border border-primary/35 bg-primary/8 p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                  {perfState === 'loading' ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Gauge className="h-5 w-5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {t('setup:welcome.perfTitle')}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {t('setup:welcome.perfBody')}
                  </span>
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <label className="sr-only" htmlFor="perf-scope">
                  {t('setup:welcome.perfScope')}
                </label>
                <select
                  id="perf-scope"
                  value={perfScope}
                  onChange={(event) => setPerfScope(event.target.value)}
                  disabled={!wsConnected || perfState === 'loading'}
                  className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t('setup:welcome.perfWholeProject')}</option>
                  {scopeDirectories.map((path) => (
                    <option key={path} value={path}>
                      {t('setup:welcome.perfDirectoryScope', { path })}
                    </option>
                  ))}
                </select>
                <label className="sr-only" htmlFor="perf-mode">
                  {t('setup:welcome.perfMode')}
                </label>
                <select
                  id="perf-mode"
                  value={perfMode}
                  onChange={(event) => setPerfMode(event.target.value as PerfRunMode)}
                  disabled={!wsConnected || perfState === 'loading'}
                  className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  {PERF_RUN_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {PERF_RUN_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <label className="sr-only" htmlFor="perf-metric">
                  {t('setup:welcome.perfMetric')}
                </label>
                <select
                  id="perf-metric"
                  value={perfMetric}
                  onChange={(event) => setPerfMetric(event.target.value as PerfRunMetric | '')}
                  disabled={!wsConnected || perfState === 'loading'}
                  className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t('setup:welcome.perfMetricAuto')}</option>
                  {PERF_RUN_METRICS.map((metric) => (
                    <option key={metric} value={metric}>
                      {PERF_RUN_METRIC_LABELS[metric]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={startPerfRun}
                  disabled={!wsConnected || savedCount === 0 || perfState === 'loading'}
                  className="group flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('setup:welcome.perfStart')}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </button>
              </div>
            </div>
            {perfState === 'error' && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {t('setup:welcome.perfError')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── No-keys CTA ── */}
      {wsConnected && savedCount === 0 && (
        <button
          type="button"
          onClick={() => openMainView('settings')}
          className={cn(
            'group rounded-xl border bg-gradient-to-r from-warning/5 to-warning/[0.02]',
            'border-warning/30 hover:border-warning/50 transition-all duration-200 shadow-sm',
            'p-5 flex items-center gap-4 text-left animate-message',
          )}
        >
          <span className="flex items-center justify-center w-11 h-11 rounded-lg bg-gradient-to-br from-warning/20 to-warning/10 text-warning shrink-0 shadow-sm shadow-warning/10">
            <KeyRound className="h-6 w-6" />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold mb-1">{t('setup:welcome.noKeyTitle')}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('setup:welcome.noKeyBody')}
            </p>
          </div>
          <span className="flex items-center gap-1 text-xs text-warning font-medium shrink-0 group-hover:translate-x-0.5 transition-transform">
            {t('setup:welcome.openSettings')} <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </button>
      )}
    </div>
  );
}
