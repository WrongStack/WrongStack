/**
 * WorkspaceDock — the strip between the chat header and the transcript.
 *
 * The dock itself stays compact above chat. Selecting Goal, Fleet, Work,
 * Worktrees, or Collab opens its content in WorkspaceDockInspector on the
 * right, so the transcript never loses vertical space.
 *
 * WorkDashboard and CollabPanel stay mounted (hidden) in the inspector while
 * collapsed — their Tasks/Plan/collab WebSocket subscriptions must survive.
 */

import {
  Bot,
  GitBranch,
  ListTodo,
  PanelRightOpen,
  Rocket,
  SlidersHorizontal,
  Target,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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

// ── Chip ──────────────────────────────────────────────────────────────

const CHIP_TONES: Record<DockSection, { active: string; idle: string }> = {
  goal: {
    active: 'bg-primary/12 border-primary/40 text-primary shadow-sm',
    idle: 'text-primary/80 hover:bg-primary/10',
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
    active: 'bg-warning/12 border-warning/35 text-warning shadow-sm',
    idle: 'text-warning/80 hover:bg-warning/10',
  },
  worktrees: {
    active: 'bg-info/12 border-info/35 text-info shadow-sm',
    idle: 'text-info/80 hover:bg-info/10',
  },
  collab: {
    active: 'bg-accent border-primary/25 text-accent-foreground shadow-sm',
    idle: 'text-muted-foreground hover:bg-muted/60',
  },
};

/** Human labels for the chip customization menu. */
const CHIP_LABELS: Record<DockSection, string> = {
  goal: 'Goal',
  'goal-state': 'Goal State',
  fleet: 'Fleet',
  work: 'Work',
  worktrees: 'Worktrees',
  collab: 'Collab',
};
const CHIP_ORDER: DockSection[] = ['goal', 'goal-state', 'fleet', 'work', 'worktrees', 'collab'];

function DockChip({
  section,
  icon,
  label,
  value,
  active,
  pulse,
  onClick,
}: {
  section: DockSection;
  icon: React.ReactNode;
  label: string;
  value?: string | undefined;
  active: boolean;
  pulse?: boolean | undefined;
  onClick: () => void;
}) {
  const tone = CHIP_TONES[section];
  const { t } = useAppTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        active
          ? t('activity:dock.collapseChip', { label })
          : t('activity:dock.expandChip', { label })
      }
      className={cn(
        'flex items-center gap-2 h-7 px-2.5 rounded-md border text-xs font-medium shrink-0 transition-colors',
        active ? tone.active : cn('border-border/40', tone.idle),
      )}
    >
      <span className={cn(pulse && 'animate-pulse')}>{icon}</span>
      {label}
      {value && <span className="tabular-nums opacity-80">{value}</span>}
    </button>
  );
}

// ── Dock ──────────────────────────────────────────────────────────────

export function WorkspaceDock() {
  const dockSection = useUIStore((s) => s.dockSection);
  const { t } = useAppTranslation();
  const toggleDockSection = useUIStore((s) => s.toggleDockSection);
  const hiddenChips = useUIStore((s) => s.hiddenChips);
  const toggleChipHidden = useUIStore((s) => s.toggleChipHidden);
  const dockCustomizeOpen = useUIStore((s) => s.dockCustomizeOpen);
  const setDockCustomizeOpen = useUIStore((s) => s.setDockCustomizeOpen);
  const activeSessionId = useActiveSessionId();

  const goalState = useGoalStateStore((s) => s.goal);
  // Narrow selectors for each field the dock reads — subscribing to the
  // entire goalRun store via `useGoalRunStore((s) => s)` re-renders the
  // dock on every store change (including status flips the dock doesn't
  // display). Each subscription only fires when its specific slice changes.
  const phasesLength = useGoalRunStore((s) => s.phases.length);
  const overallPercent = useGoalRunStore((s) => s.overallPercent);
  const activePhaseId = useGoalRunStore((s) => s.activePhaseId);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const todos = useSessionStore((s) => s.todos);
  const fleetAgents = useFleetStore((s) => s.agents);

  const gitInfo = useGitInfo();

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
    goal: phasesActive,
    'goal-state': goalState !== null,
    fleet: fleetTotal > 0,
    work: true,
    worktrees: worktrees.length > 0,
    collab: true,
  };
  const visible: Record<DockSection, boolean> = {
    goal: (hasData.goal || dockSection === 'goal') && !hidden.has('goal'),
    'goal-state':
      (hasData['goal-state'] || dockSection === 'goal-state') && !hidden.has('goal-state'),
    fleet: (hasData.fleet || dockSection === 'fleet') && !hidden.has('fleet'),
    work: (hasData.work || dockSection === 'work') && !hidden.has('work'),
    worktrees: (hasData.worktrees || dockSection === 'worktrees') && !hidden.has('worktrees'),
    collab: (hasData.collab || dockSection === 'collab') && !hidden.has('collab'),
  };
  const open = dockSection && visible[dockSection] ? dockSection : null;

  return (
    <div>
      {/* ── Chip strip ── */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/70 bg-card/70 px-2 py-1.5 shadow-sm">
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
        {visible.worktrees && (
          <DockChip
            section="worktrees"
            icon={<GitBranch className="h-3 w-3" />}
            label={t('activity:dock.worktrees')}
            value={String(worktrees.length)}
            active={open === 'worktrees'}
            onClick={() => toggleDockSection('worktrees')}
          />
        )}
        {/* Git info chip — shows branch, changes, and sync status.
         * Mirrors the TUI's git-info bar in the status line. */}
        {gitInfo && (
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
};

export function WorkspaceDockInspector({ sessionId }: { sessionId: string }): React.ReactElement {
  const dockSection = useUIStore((s) => s.dockSection);
  const setDockSection = useUIStore((s) => s.setDockSection);
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const goalState = useGoalStateStore((s) => s.goal);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);
  const [worktreeView, setWorktreeView] = useState<'graph' | 'lanes'>('graph');
  const { t } = useAppTranslation();

  const open = dockSection !== null && dockSection !== 'goal';
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
      aria-hidden={!open}
      inert={!open || undefined}
      aria-label={
        meta
          ? t('activity:dock.inspectorNamed', { name: t(meta.titleKey) })
          : t('activity:dock.inspector')
      }
      className={cn(
        'fixed inset-y-0 right-0 z-40 flex w-[calc(100vw-3rem)] max-w-none flex-col overflow-hidden border-l border-border/80 bg-card/96 shadow-[-24px_0_64px_-36px_hsl(var(--shadow-color)/0.65)] backdrop-blur-xl transition-transform duration-200 sm:w-[min(680px,48vw)] sm:max-w-[680px]',
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
            <GoalPanel goal={goalState} />
          ) : (
            <DockEmptyState
              title={t('activity:dock.noActiveGoal')}
              detail={t('activity:dock.noActiveGoalDetail')}
            />
          ))}
        {section === 'fleet' && <FleetPanel />}
        {section === 'worktrees' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {(['graph', 'lanes'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  onClick={() => setWorktreeView(view)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs capitalize transition-colors',
                    worktreeView === view
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {view}
                </button>
              ))}
            </div>
            <WorktreeOrphans />
            {worktreeView === 'graph' ? (
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
