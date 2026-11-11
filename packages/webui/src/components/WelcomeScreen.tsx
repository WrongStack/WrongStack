import {
  ArrowRight,
  ChevronDown,
  FolderOpen,
  KeyRound,
  Loader2,
  Palette,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useIsFullChrome } from '@/hooks/useChromeLevel';
import { useAppTranslation } from '@/i18n';
import {
  BUG_HUNT_LIMITS,
  BUG_HUNT_MODE_DESCRIPTIONS,
  BUG_HUNT_MODE_LABELS,
  BUG_HUNT_MODE_SLUGS,
  BUG_HUNT_MODES,
  type BugHuntLimit,
  type BugHuntMode,
  buildBugHuntMessage,
} from '@/lib/bug-hunt-message';
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
import { openMainView, showPanel } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore, useFileStore, useSessionStore } from '@/stores';
import { useBugHuntRunStore } from '@/stores/bug-hunt-run-store';
import type { TreeNode } from '@/stores/file-store';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';
import { WelcomeDesignLauncher } from './WelcomeDesignLauncher';
import { LauncherArt, WorkbenchArt } from './WorkbenchArt';

/**
 * Header row of a launcher card. Under calm chrome it is the card's toggle —
 * the form below stays folded until asked for; under full chrome it is the
 * plain row it always was and the form is always open.
 */
function LauncherHeader({
  foldable,
  expanded,
  onToggle,
  testId,
  children,
}: {
  foldable: boolean;
  expanded: boolean;
  onToggle: () => void;
  testId: string;
  children: ReactNode;
}) {
  if (!foldable) return <div className="flex items-center gap-3">{children}</div>;
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex w-full items-center gap-3 text-left"
    >
      {children}
      <ChevronDown
        className={cn(
          'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
          expanded && 'rotate-180',
        )}
        aria-hidden
      />
    </button>
  );
}

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
  const [bugHuntMode, setBugHuntMode] = useState<BugHuntMode>('bughunt');
  const [bugHuntMaxBugs, setBugHuntMaxBugs] = useState<BugHuntLimit>(1);
  const [perfState, setPerfState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [perfScope, setPerfScope] = useState('');
  const [perfMode, setPerfMode] = useState<PerfRunMode>('ratchet');
  const [perfMetric, setPerfMetric] = useState<PerfRunMetric | ''>('');
  // Calm chrome folds the launcher forms; at most one is open at a time.
  // A launch in flight or a failed one keeps its card open so its state shows.
  const fullChrome = useIsFullChrome();
  const [openLauncher, setOpenLauncher] = useState<'bug' | 'perf' | 'design' | null>(null);
  const toggleLauncher = (which: 'bug' | 'perf' | 'design') =>
    setOpenLauncher((current) => (current === which ? null : which));
  const bugOpen = fullChrome || openLauncher === 'bug' || bugHuntState !== 'idle';
  const perfOpen = fullChrome || openLauncher === 'perf' || perfState !== 'idle';
  const designOpen = fullChrome || openLauncher === 'design';
  const scopeDirectories = directoryPaths(projectTree);
  const heroSubtitle = !wsConnected
    ? t('setup:welcome.heroSubtitleDisconnected')
    : savedCount === 0
      ? t('setup:welcome.heroSubtitleNeedsProvider')
      : t('setup:welcome.heroSubtitle');
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
    const modePatch = bugHuntMode !== 'bughunt' ? { mode: bugHuntMode } : {};

    launchBuiltinRound({
      client,
      slug: BUG_HUNT_MODE_SLUGS[bugHuntMode],
      requireSoloSession: true,
      // Solo, but memory + explore companions stay: they are read-only.
      keepCompanions: true,
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
This is round 1/${bugHuntMaxBugs}. Investigate at most one proven bug in this round: discovery, proof, fix, verification, and cleanup. If no legitimate proof is possible, report no-proven-bug or blocked without changing production code. Stop after the round report; the WebUI will start another round only after this one finishes successfully and only while below the configured limit. Stay strictly within ${scopeText}.`,
          { scope: bugHuntScope, maxBugs: bugHuntMaxBugs, currentRound: 1, ...modePatch },
        );
      },
      onSent: (id, content) => {
        if (sessionId) {
          useBugHuntRunStore.getState().start(sessionId, {
            scope: bugHuntScope,
            totalRounds: bugHuntMaxBugs,
            currentRound: 1,
            requestId: id,
            ...modePatch,
          });
        }
        addMessage({
          id,
          role: 'user',
          content,
          bugHunt: { scope: bugHuntScope, maxBugs: bugHuntMaxBugs, currentRound: 1, ...modePatch },
        });
        setLoading(true);
      },
      onSettle: setBugHuntState,
    });
  }, [
    addMessage,
    bugHuntMaxBugs,
    bugHuntMode,
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

  const noKeyCta = (
    <>
      {wsConnected && savedCount === 0 && (
        <button
          type="button"
          onClick={() => openMainView('settings')}
          className={cn(
            'group rounded-xl border bg-gradient-to-r from-warning/5 to-warning/[0.02]',
            'border-warning/30 hover:border-warning/50 transition-all duration-200 shadow-sm',
            'p-5 flex flex-wrap sm:flex-nowrap items-center gap-4 text-left animate-message',
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
          <span className="flex w-full sm:w-auto items-center gap-1 text-xs text-warning font-medium shrink-0 group-hover:translate-x-0.5 transition-transform">
            {t('setup:welcome.openSettings')} <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </button>
      )}
    </>
  );

  return (
    <div className="ws-welcome flex flex-col mx-auto w-full">
      {/* Calm chrome: with no provider key nothing else here can run, so
          that call to action leads instead of trailing the launchers. */}
      {!fullChrome && noKeyCta}
      <div className="ws-welcome-hero">
        <div className="ws-welcome-hero-copy min-w-0">
          <div className="ws-welcome-eyebrow">WrongStack / {t('activity:nav.chat')}</div>
          <h2 className="ws-welcome-title">
            {projectName
              ? t('setup:welcome.heroTitleInProject', { name: projectName })
              : t('setup:welcome.heroTitle')}
          </h2>
          <p className="mt-3 max-w-md text-sm text-muted-foreground leading-relaxed">
            {heroSubtitle}
          </p>
          {!wsConnected && (
            <button
              type="button"
              onClick={() => getWSClient(wsUrl).retryNow()}
              className="mt-4 inline-flex min-h-9 items-center gap-2 border border-primary/40 bg-primary/10 px-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/15 pointer-coarse:min-h-11"
            >
              <WifiOff className="h-4 w-4" aria-hidden />
              {t('setup:welcome.reconnect')}
            </button>
          )}
          <div className="ws-welcome-meta">
            {provider && model && (
              <p>
                {provider} / {model}
              </p>
            )}
            {cwd && <p title={cwd}>{t('setup:welcome.workingDirectory', { cwd })}</p>}
          </div>
        </div>
        <WorkbenchArt />
      </div>
      <div className="ws-welcome-shortcuts">
        <button type="button" className="ws-welcome-shortcut" onClick={() => showPanel('files')}>
          <FolderOpen className="h-4 w-4 shrink-0" aria-hidden />
          <span>{t('activity:nav.files')}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
        <button type="button" className="ws-welcome-shortcut" onClick={() => showPanel('skills')}>
          <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
          <span>{t('activity:nav.skills')}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
        <button type="button" className="ws-welcome-shortcut" onClick={() => showPanel('design')}>
          <Palette className="h-4 w-4 shrink-0" aria-hidden />
          <span>{t('setup:welcome.design.studioShortcut')}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
        <button
          type="button"
          className="ws-welcome-shortcut"
          onClick={() => openMainView('settings')}
        >
          <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden />
          <span>{t('activity:topbar.view.settings')}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
      </div>
      <div>
        <button
          type="button"
          role="switch"
          aria-checked={!subagentsAllowed}
          aria-label={t('setup:welcome.soloSessionTitle')}
          onClick={toggleSoloSession}
          disabled={!wsConnected}
          className={cn(
            'mb-3 flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors',
            !subagentsAllowed
              ? 'border-warning/45 bg-card'
              : 'border-border/70 bg-card hover:bg-muted/45',
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
        <div className="ws-welcome-launchers">
          <div className="ws-launcher-card border border-border p-4">
            <LauncherHeader
              foldable={!fullChrome}
              expanded={bugOpen}
              onToggle={() => toggleLauncher('bug')}
              testId="welcome-launcher-bug"
            >
              <span className="ws-launcher-art flex items-center justify-center">
                {bugHuntState === 'loading' ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <LauncherArt kind="audit" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">
                  {bugHuntMode !== 'bughunt'
                    ? BUG_HUNT_MODE_LABELS[bugHuntMode]
                    : t('setup:welcome.bugHunterTitle')}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {bugHuntMode !== 'bughunt'
                    ? BUG_HUNT_MODE_DESCRIPTIONS[bugHuntMode]
                    : t('setup:welcome.bugHunterBody')}
                </span>
              </span>
            </LauncherHeader>
            {bugOpen && (
              <div className="ws-launcher-fields mt-4 grid gap-2">
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
                <label className="sr-only" htmlFor="bug-hunt-mode">
                  {t('setup:welcome.bugHunterMode')}
                </label>
                <select
                  id="bug-hunt-mode"
                  value={bugHuntMode}
                  onChange={(event) => setBugHuntMode(event.target.value as BugHuntMode)}
                  disabled={!wsConnected || bugHuntState === 'loading'}
                  className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  {BUG_HUNT_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {BUG_HUNT_MODE_LABELS[mode]}
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
                    onChange={(event) =>
                      setBugHuntMaxBugs(Number(event.target.value) as BugHuntLimit)
                    }
                    disabled={!wsConnected || bugHuntState === 'loading'}
                    className="min-w-0 bg-transparent font-semibold outline-none"
                  >
                    {BUG_HUNT_LIMITS.map((count) => (
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
            )}
            {bugHuntState === 'error' && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {t('setup:welcome.bugHunterError')}
              </p>
            )}
          </div>
          <div className="ws-launcher-card ws-launcher-card--perf border border-border p-4">
            <LauncherHeader
              foldable={!fullChrome}
              expanded={perfOpen}
              onToggle={() => toggleLauncher('perf')}
              testId="welcome-launcher-perf"
            >
              <span className="ws-launcher-art flex items-center justify-center">
                {perfState === 'loading' ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <LauncherArt kind="performance" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{t('setup:welcome.perfTitle')}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {t('setup:welcome.perfBody')}
                </span>
              </span>
            </LauncherHeader>
            {perfOpen && (
              <>
                <div className="ws-launcher-fields mt-4 grid gap-2">
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
                <div className="ws-launcher-fields mt-2 grid gap-2">
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
              </>
            )}
            {perfState === 'error' && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {t('setup:welcome.perfError')}
              </p>
            )}
          </div>
          <WelcomeDesignLauncher
            foldable={!fullChrome}
            expanded={designOpen}
            onToggle={() => toggleLauncher('design')}
            savedCount={savedCount}
          />
        </div>
      </div>

      {/* ── No-keys CTA ── (full chrome: after the launchers, as before) */}
      {fullChrome && noKeyCta}
    </div>
  );
}
