/**
 * WorkspaceDock — session workspace controls in the left Session panel.
 *
 * The dock itself stays compact. Selecting Goal, Fleet, Work,
 * Worktrees, or Collab opens its content in WorkspaceDockInspector on the
 * right, so the transcript never loses vertical space.
 *
 * WorkDashboard and CollabPanel stay mounted (hidden) in the inspector while
 * collapsed — their Tasks/Plan/collab WebSocket subscriptions must survive.
 */

import {
  BookOpen,
  Bot,
  GitBranch,
  Globe,
  ListTodo,
  PanelRightOpen,
  Rocket,
  SlidersHorizontal,
  Target,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLiveBrowserSessions } from '@/hooks/use-live-browser';
import { useArchitectureDecisionInbox } from '@/hooks/useArchitectureDecisionInbox';
import { useIsFullChrome } from '@/hooks/useChromeLevel';
import { useGitInfo } from '@/hooks/useGitInfo';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { cn } from '@/lib/utils';
import { openMainView } from '@/lib/view-navigation';
import {
  useActiveSessionId,
  useFleetStore,
  useGoalRunStore,
  useGoalStateStore,
  useSessionStore,
  useUIStore,
  useWorktreeStore,
} from '@/stores';
import type { DockSection } from '@/stores/ui-store';
import { ArchitectureDecisionsPanel } from './ArchitectureDecisionsPanel';
import { BrowserLivePane } from './BrowserLivePane';
import { CollabPanel } from './CollabPanel';
import { FleetPanel } from './FleetPanel';
import { GoalPanel } from './GoalPanel';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { WorkDashboard } from './WorkDashboard';
import { WorktreeGraph } from './WorktreeGraph';
import { WorktreeLanes } from './WorktreeLanes';
import { WorktreeOrphans } from './WorktreeOrphans';
import {
  useSessionWorktreeCount,
  WorktreeTimelineView,
  type WorktreeViewMode,
  WorktreeViewSwitch,
} from './WorktreeTimeline';

// ── Chip ──────────────────────────────────────────────────────────────

const CHIP_TONES: Record<DockSection, { active: string; idle: string }> = {
  adr: {
    active: 'bg-primary/12 border-primary/40 text-foreground shadow-sm',
    idle: 'text-muted-foreground hover:bg-primary/10 hover:text-foreground',
  },
  goal: {
    active: 'bg-primary/12 border-primary/40 text-foreground shadow-sm',
    idle: 'text-muted-foreground hover:bg-primary/10 hover:text-foreground',
  },
  'goal-state': {
    active: 'bg-destructive/10 border-destructive/35 text-destructive shadow-sm',
    idle: 'text-destructive/80 hover:bg-destructive/10',
  },
  fleet: {
    active: 'bg-success/12 border-success/35 text-success shadow-sm',
    idle: 'text-success/80 hover:bg-success/10',
  },
  work: {
    active: 'bg-warning/12 border-warning/35 text-foreground shadow-sm',
    idle: 'text-muted-foreground hover:bg-warning/10 hover:text-foreground',
  },
  worktrees: {
    active: 'bg-info/12 border-info/35 text-foreground shadow-sm',
    idle: 'text-muted-foreground hover:bg-info/10 hover:text-foreground',
  },
  collab: {
    active: 'bg-accent border-primary/25 text-accent-foreground shadow-sm',
    idle: 'text-muted-foreground hover:bg-muted/60',
  },
  browser: {
    active: 'bg-info/12 border-info/35 text-foreground shadow-sm',
    idle: 'text-muted-foreground hover:bg-info/10 hover:text-foreground',
  },
};

/** Human labels for the chip customization menu. */
const CHIP_LABELS: Record<DockSection, string> = {
  adr: 'Architecture decisions',
  goal: 'Goal',
  'goal-state': 'Goal State',
  fleet: 'Fleet',
  work: 'Work',
  worktrees: 'Worktrees',
  collab: 'Collab',
  browser: 'Browser',
};
const CHIP_ORDER: DockSection[] = [
  'adr',
  'goal',
  'goal-state',
  'fleet',
  'work',
  'worktrees',
  'collab',
  'browser',
];

/**
 * Calm chrome: an idle chip is plain grey — colour marks the chip you opened,
 * not every section that happens to have data. Goal State takes the Goal tone
 * when open instead of the destructive red it uses under full chrome.
 */
const CALM_IDLE_TONE = 'text-muted-foreground hover:bg-muted/60 hover:text-foreground';
const CALM_ACTIVE_OVERRIDE: Partial<Record<DockSection, string>> = {
  'goal-state': CHIP_TONES.goal.active,
};

function DockChip({
  section,
  icon,
  label,
  value,
  valueLabel,
  active,
  pulse,
  onClick,
}: {
  section: DockSection;
  icon: React.ReactNode;
  label: string;
  value?: string | undefined;
  valueLabel?: string | undefined;
  active: boolean;
  pulse?: boolean | undefined;
  onClick: () => void;
}) {
  const tone = CHIP_TONES[section];
  const fullChrome = useIsFullChrome();
  const { t } = useAppTranslation();
  const activeTone = fullChrome ? tone.active : (CALM_ACTIVE_OVERRIDE[section] ?? tone.active);
  const idleTone = fullChrome ? tone.idle : CALM_IDLE_TONE;
  return (
    <button
      type="button"
      data-active={active}
      onClick={onClick}
      title={
        active
          ? t('activity:dock.collapseChip', { label })
          : t('activity:dock.expandChip', { label })
      }
      className={cn(
        'ws-dock-chip flex items-center gap-2 h-8 px-3 rounded-lg border text-xs font-medium shrink-0',
        active ? activeTone : cn('border-border/40', idleTone),
      )}
    >
      <span className={cn(pulse && 'animate-pulse')}>{icon}</span>
      {label}
      {value && (
        <span title={valueLabel} className="tabular-nums opacity-80">
          <span aria-hidden={!!valueLabel}>{value}</span>
          {valueLabel && <span className="sr-only">{valueLabel}</span>}
        </span>
      )}
    </button>
  );
}

// ── Dock ──────────────────────────────────────────────────────────────

export function WorkspaceDock() {
  const dockSection = useUIStore((s) => s.dockSection);
  const { t } = useAppTranslation();
  const toggleDockSection = useUIStore((s) => s.toggleDockSection);
  const hiddenChips = useUIStore((s) => s.hiddenChips);
  const fullChrome = useIsFullChrome();
  const toggleChipHidden = useUIStore((s) => s.toggleChipHidden);
  const dockCustomizeOpen = useUIStore((s) => s.dockCustomizeOpen);
  const setDockCustomizeOpen = useUIStore((s) => s.setDockCustomizeOpen);
  const activeSessionId = useActiveSessionId();
  const adrInbox = useArchitectureDecisionInbox(activeSessionId, !hiddenChips.includes('adr'));

  const goalState = useGoalStateStore((s) => s.goal);
  // Narrow selectors for each field the dock reads — subscribing to the
  // entire goalRun store via `useGoalRunStore((s) => s)` re-renders the
  // dock on every store change (including status flips the dock doesn't
  // display). Each subscription only fires when its specific slice changes.
  const phasesLength = useGoalRunStore((s) => s.phases.length);
  const overallPercent = useGoalRunStore((s) => s.overallPercent);
  const activePhaseId = useGoalRunStore((s) => s.activePhaseId);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  // History counts too: a finished run's worktrees stay inspectable.
  const sessionWorktreeCount = useSessionWorktreeCount(activeSessionId ?? undefined);
  const todos = useSessionStore((s) => s.todos);
  const fleetAgents = useFleetStore((s) => s.agents);

  const gitInfo = useGitInfo();
  const browserSessions = useLiveBrowserSessions();

  const sessionFleetAgents = useMemo(
    () =>
      Array.from(fleetAgents.values()).filter((a) =>
        agentBelongsToSession(a.sessionId, activeSessionId),
      ),
    [fleetAgents, activeSessionId],
  );
  const fleetTotal = sessionFleetAgents.length;
  const fleetRunning = useMemo(
    () => sessionFleetAgents.filter((a) => a.status === 'running').length,
    [sessionFleetAgents],
  );
  const todosDone = todos.filter((t) => t.status === 'completed').length;
  const todosActive = todos.some((t) => t.status === 'in_progress');
  const phasesActive = phasesLength > 0;

  // Chip visibility — a section without data shows no chip, and an open
  // section whose data vanished collapses rather than rendering a husk.
  // A chip the user hid via the customization menu is always suppressed.
  const hidden = useMemo(() => new Set(hiddenChips), [hiddenChips]);
  const hasData: Record<DockSection, boolean> = {
    adr: true,
    goal: phasesActive,
    'goal-state': goalState !== null,
    fleet: fleetTotal > 0,
    work: true,
    worktrees: worktrees.length > 0 || sessionWorktreeCount > 0,
    collab: true,
    browser: browserSessions.length > 0,
  };
  const visible: Record<DockSection, boolean> = {
    adr: !hidden.has('adr'),
    goal: (hasData.goal || dockSection === 'goal') && !hidden.has('goal'),
    'goal-state':
      (hasData['goal-state'] || dockSection === 'goal-state') && !hidden.has('goal-state'),
    // Calm chrome: agents live in the right inspector (topbar "Agents"), so
    // the dock does not offer a second fleet view.
    fleet: fullChrome && (hasData.fleet || dockSection === 'fleet') && !hidden.has('fleet'),
    work: (hasData.work || dockSection === 'work') && !hidden.has('work'),
    worktrees: (hasData.worktrees || dockSection === 'worktrees') && !hidden.has('worktrees'),
    collab: (hasData.collab || dockSection === 'collab') && !hidden.has('collab'),
    browser: (hasData.browser || dockSection === 'browser') && !hidden.has('browser'),
  };
  const open = dockSection && visible[dockSection] ? dockSection : null;

  return (
    <div>
      {/* ── Chip strip ── */}
      <div className="ws-dock-surface flex flex-wrap items-center gap-1.5 rounded-xl border border-border/70 px-2 py-2 shadow-sm">
        {visible.goal && (
          <DockChip
            section="goal"
            icon={<Rocket className="h-3 w-3" />}
            label={t('activity:dock.goal')}
            value={`${overallPercent}%`}
            active={false}
            pulse={activePhaseId != null}
            // Goal opens straight into the full board view — the inline
            // panel hogged vertical space above the chat history.
            onClick={() => openMainView('goal')}
          />
        )}
        {visible['goal-state'] && goalState && (
          <DockChip
            section="goal-state"
            icon={<Target className="h-3 w-3" />}
            label={t('activity:dock.goalState')}
            value={`${goalState.progress}%`}
            active={open === 'goal-state'}
            pulse={goalState.goalState === 'active'}
            onClick={() => toggleDockSection('goal-state')}
          />
        )}
        {visible.fleet && (
          <DockChip
            section="fleet"
            icon={<Bot className="h-3 w-3" />}
            label={t('activity:dock.fleet')}
            value={`${fleetRunning}/${fleetTotal}`}
            active={open === 'fleet'}
            pulse={fleetRunning > 0}
            onClick={() => toggleDockSection('fleet')}
          />
        )}
        <DockChip
          section="work"
          icon={<ListTodo className="h-3 w-3" />}
          label={t('activity:dock.work')}
          value={todos.length > 0 ? `${todosDone}/${todos.length}` : undefined}
          active={open === 'work'}
          pulse={todosActive}
          onClick={() => toggleDockSection('work')}
        />
        {visible.browser && (
          <DockChip
            section="browser"
            icon={<Globe className="h-3 w-3" />}
            label={t('activity:dock.browser')}
            value={browserSessions.length > 1 ? String(browserSessions.length) : undefined}
            active={open === 'browser'}
            pulse={browserSessions.length > 0}
            onClick={() => toggleDockSection('browser')}
          />
        )}
        {visible.worktrees && (
          <DockChip
            section="worktrees"
            icon={<GitBranch className="h-3 w-3" />}
            label={t('activity:dock.worktrees')}
            value={String(worktrees.length > 0 ? worktrees.length : sessionWorktreeCount)}
            pulse={worktrees.length > 0}
            active={open === 'worktrees'}
            onClick={() => toggleDockSection('worktrees')}
          />
        )}
        {/* Git info chip — shows branch, changes, and sync status.
         * Mirrors the TUI's git-info bar in the status line. */}
        {/* No branch = not a git repository: no chip. */}
        {gitInfo?.branch && (
          <button
            type="button"
            onClick={() => {
              // Toggle dock section to git if implemented; for now just
              // show the branch name and stats as a static info chip.
            }}
            className="inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border/50 px-2.5 text-xs font-mono transition-colors hover:bg-muted/60 sm:h-7"
          >
            <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-semibold text-foreground">{gitInfo.branch}</span>
            {gitInfo.ahead > 0 && (
              <span
                className="text-success"
                title={t('activity:dock.ahead', { count: gitInfo.ahead })}
              >
                ↑{gitInfo.ahead}
              </span>
            )}
            {gitInfo.behind > 0 && (
              <span
                className="text-warning"
                title={t('activity:dock.behind', { count: gitInfo.behind })}
              >
                ↓{gitInfo.behind}
              </span>
            )}
            {gitInfo.added > 0 && (
              <span
                className="text-success"
                title={t('activity:dock.linesAdded', { count: gitInfo.added })}
              >
                +{gitInfo.added}
              </span>
            )}
            {gitInfo.deleted > 0 && (
              <span
                className="text-destructive"
                title={t('activity:dock.linesDeleted', { count: gitInfo.deleted })}
              >
                -{gitInfo.deleted}
              </span>
            )}
            {gitInfo.untracked > 0 && (
              <span
                className="text-muted-foreground"
                title={t('activity:dock.untrackedFiles', { count: gitInfo.untracked })}
              >
                {gitInfo.untracked}?
              </span>
            )}
          </button>
        )}
        <DockChip
          section="collab"
          icon={<Users className="h-3 w-3" />}
          label={t('activity:dock.collab')}
          active={open === 'collab'}
          onClick={() => toggleDockSection('collab')}
        />

        {/* Chip customization menu — TUI F12 status-line picker parity. */}
        {visible.adr && (
          <DockChip
            section="adr"
            icon={<BookOpen className="h-3 w-3" />}
            label={t('activity:adr.shortTitle')}
            value={
              adrInbox.unavailable
                ? '?'
                : adrInbox.summary?.pending
                  ? String(adrInbox.summary.pending)
                  : undefined
            }
            valueLabel={
              adrInbox.unavailable
                ? t('activity:adr.inboxUnavailable')
                : t('activity:adr.pendingCount', { count: adrInbox.summary?.pending ?? 0 })
            }
            active={open === 'adr'}
            onClick={() => toggleDockSection('adr')}
          />
        )}
        <DropdownMenu open={dockCustomizeOpen} onOpenChange={setDockCustomizeOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={t('activity:dock.customizeTitle')}
              className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-md border border-border/50 text-muted-foreground hover:bg-muted/60 transition-colors shrink-0"
            >
              <SlidersHorizontal className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{t('activity:dock.dockChips')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {CHIP_ORDER.map((section) => (
              <DropdownMenuCheckboxItem
                key={section}
                checked={!hidden.has(section)}
                onCheckedChange={() => toggleChipHidden(section)}
                onSelect={(e) => e.preventDefault()}
              >
                {CHIP_LABELS[section]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Hook-free constant: the inspector resolves these keys when it renders. */
const DOCK_INSPECTOR_META: Record<
  Exclude<DockSection, 'goal'>,
  { titleKey: string; detailKey: string }
> = {
  adr: { titleKey: 'activity:adr.title', detailKey: 'activity:adr.description' },
  'goal-state': {
    titleKey: 'activity:dock.goalState',
    detailKey: 'activity:dock.goalStateDetail',
  },
  fleet: { titleKey: 'activity:dock.fleet', detailKey: 'activity:dock.fleetDetail' },
  work: { titleKey: 'activity:dock.work', detailKey: 'activity:dock.workDetail' },
  worktrees: {
    titleKey: 'activity:dock.worktrees',
    detailKey: 'activity:dock.worktreesDetail',
  },
  collab: { titleKey: 'activity:dock.collab', detailKey: 'activity:dock.collabDetail' },
  browser: { titleKey: 'activity:dock.browser', detailKey: 'activity:dock.browserDetail' },
};

export function WorkspaceDockInspector({ sessionId }: { sessionId: string }): React.ReactElement {
  const dockSection = useUIStore((s) => s.dockSection);
  const setDockSection = useUIStore((s) => s.setDockSection);
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const goalState = useGoalStateStore((s) => s.goal);
  const refiningMissionId = useGoalStateStore((s) => s.refiningMissionId);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);
  const [worktreeView, setWorktreeView] = useState<WorktreeViewMode>('timeline');
  const { t } = useAppTranslation();

  const fullChrome = useIsFullChrome();
  // Calm chrome has no Fleet chip; a persisted 'fleet' section stays closed.
  const open =
    dockSection !== null && dockSection !== 'goal' && (fullChrome || dockSection !== 'fleet');
  const section = open ? dockSection : null;
  const meta = section ? DOCK_INSPECTOR_META[section] : null;

  // Stack-aware positioning: when the global InspectorPanel (fleet/agents/audit)
  // is also open, offset this panel to the left so the two don't overlap.
  // The InspectorPanel is `sm:w-[min(680px,48vw)]` — we mirror that width
  // as the offset. On mobile (`w-[calc(100vw-3rem)]`) both panels are
  // full-width so stacking isn't useful; the user should close one.
  const stackedOffset = inspectorOpen && open ? 'sm:right-[min(680px,48vw)]' : '';

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDockSection(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, setDockSection]);

  return (
    <aside
      id="workspace-dock-inspector"
      data-testid={open ? 'workspace-dock-inspector' : undefined}
      data-escape-owns={open ? 'true' : undefined}
      aria-hidden={!open}
      inert={!open || undefined}
      aria-label={
        meta
          ? t('activity:dock.inspectorNamed', { name: t(meta.titleKey) })
          : t('activity:dock.inspector')
      }
      className={cn(
        // `absolute`, not `fixed`: the drawer is anchored to the WORK SURFACE
        // (the positioned container in App.tsx), so it starts below the app's
        // top chrome. Fixed to the viewport it covered the session tab strip
        // and swallowed clicks on the rightmost tabs — the strip is the one
        // control that must stay reachable while the drawer is open.
        'absolute inset-y-0 right-0 z-40 flex w-[calc(100vw-3rem)] max-w-none flex-col overflow-hidden border-l border-border/80 bg-card/96 shadow-[-24px_0_64px_-36px_hsl(var(--shadow-color)/0.65)] backdrop-blur-xl transition-transform duration-200 sm:w-[min(680px,48vw)] sm:max-w-[680px]',
        stackedOffset,
        open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
      )}
    >
      <header className="relative shrink-0 border-b border-border/70 bg-muted/20 px-4 py-3 pr-12">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <PanelRightOpen className="h-4 w-4 text-primary" />
          {meta ? t(meta.titleKey) : t('activity:dock.workspace')}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {meta ? t(meta.detailKey) : t('activity:dock.workspaceDetails')}
        </p>
        <button
          type="button"
          data-testid="workspace-dock-inspector-close"
          onClick={() => setDockSection(null)}
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t('activity:dock.closeWorkspaceInspector')}
          title={t('activity:dock.closeWorkspaceInspector')}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4">
        {section === 'goal-state' &&
          (goalState ? (
            <GoalPanel goal={goalState} refining={refiningMissionId !== null} />
          ) : (
            <DockEmptyState
              title={t('activity:dock.noActiveGoal')}
              detail={t('activity:dock.noActiveGoalDetail')}
            />
          ))}
        {section === 'fleet' && <FleetPanel />}
        {section === 'browser' && <BrowserLivePane />}
        {section === 'adr' && <ArchitectureDecisionsPanel sessionId={sessionId} />}
        {section === 'worktrees' && (
          <div className="space-y-3">
            <WorktreeViewSwitch value={worktreeView} onChange={setWorktreeView} />
            <WorktreeOrphans />
            {worktreeView === 'timeline' ? (
              <WorktreeTimelineView sessionId={sessionId || undefined} />
            ) : worktreeView === 'graph' ? (
              <WorktreeGraph worktrees={worktrees} baseBranch={baseBranch || 'HEAD'} />
            ) : (
              <WorktreeLanes worktrees={worktrees} baseBranch={baseBranch || 'HEAD'} />
            )}
          </div>
        )}
        {/* These stay mounted to preserve their subscriptions and local state. */}
        <div className={cn(section === 'work' ? 'block' : 'hidden')} id="panel-work">
          <WorkDashboard />
        </div>
        <div className={cn(section === 'collab' ? 'block' : 'hidden')}>
          <CollabPanel sessionId={sessionId} />
        </div>
      </div>
    </aside>
  );
}

function DockEmptyState({ title, detail }: { title: string; detail: string }): React.ReactElement {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 text-muted-foreground">{detail}</div>
    </div>
  );
}
