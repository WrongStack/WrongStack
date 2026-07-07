/**
 * WorkspaceDock — the strip between the chat header and the transcript.
 *
 * Replaces the old vertical pile of panels (Collab, Goal, AutoPhase
 * quick-start, Fleet, WorkDashboard, Worktrees) that pushed the chat
 * history off-screen. One slim row of labeled chips with live numbers;
 * clicking a chip expands exactly one panel below it, clicking again
 * collapses. Chips only appear when their subsystem has something to show.
 *
 * WorkDashboard and CollabPanel stay mounted (hidden) while collapsed —
 * their Tasks/Plan/collab WebSocket subscriptions must survive.
 */

import { Bot, GitBranch, ListTodo, Rocket, SlidersHorizontal, Target, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { openMainView } from '@/lib/view-navigation';
import { cn } from '@/lib/utils';
import { useGitInfo } from '@/hooks/useGitInfo';
import {
  useAutoPhaseStore,
  useFleetStore,
  useGoalStore,
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
  autophase: {
    active: 'bg-primary/12 border-primary/40 text-primary shadow-sm',
    idle: 'text-primary/80 hover:bg-primary/10',
  },
  goal: {
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
  autophase: 'AutoPhase',
  goal: 'Goal',
  fleet: 'Fleet',
  work: 'Work',
  worktrees: 'Worktrees',
  collab: 'Collab',
};
const CHIP_ORDER: DockSection[] = ['autophase', 'goal', 'fleet', 'work', 'worktrees', 'collab'];

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
      title={active ? t('activity:dock.collapseChip', { label }) : t('activity:dock.expandChip', { label })}
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

export function WorkspaceDock({ sessionId }: { sessionId: string }) {
  const dockSection = useUIStore((s) => s.dockSection);
  const { t } = useAppTranslation();
  const toggleDockSection = useUIStore((s) => s.toggleDockSection);
  const hiddenChips = useUIStore((s) => s.hiddenChips);
  const toggleChipHidden = useUIStore((s) => s.toggleChipHidden);
  const dockCustomizeOpen = useUIStore((s) => s.dockCustomizeOpen);
  const setDockCustomizeOpen = useUIStore((s) => s.setDockCustomizeOpen);

  const goal = useGoalStore((s) => s.goal);
  // Narrow selectors for each field the dock reads — subscribing to the
  // entire autoPhase store via `useAutoPhaseStore((s) => s)` re-renders the
  // dock on every store change (including status flips the dock doesn't
  // display). Each subscription only fires when its specific slice changes.
  const phasesLength = useAutoPhaseStore((s) => s.phases.length);
  const overallPercent = useAutoPhaseStore((s) => s.overallPercent);
  const activePhaseId = useAutoPhaseStore((s) => s.activePhaseId);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);
  const todos = useSessionStore((s) => s.todos);
  const fleetAgents = useFleetStore((s) => s.agents);

  const gitInfo = useGitInfo();

  const [worktreeView, setWorktreeView] = useState<'graph' | 'lanes'>('graph');

  const fleetTotal = fleetAgents.size;
  const fleetRunning = useMemo(
    () => Array.from(fleetAgents.values()).filter((a) => a.status === 'running').length,
    [fleetAgents],
  );
  const todosDone = todos.filter((t) => t.status === 'completed').length;
  const todosActive = todos.some((t) => t.status === 'in_progress');
  const phasesActive = phasesLength > 0;

  // Chip visibility — a section without data shows no chip, and an open
  // section whose data vanished collapses rather than rendering a husk.
  // A chip the user hid via the customization menu is always suppressed.
  const hidden = useMemo(() => new Set(hiddenChips), [hiddenChips]);
  const hasData: Record<DockSection, boolean> = {
    autophase: phasesActive,
    goal: goal !== null,
    fleet: fleetTotal > 0,
    work: true,
    worktrees: worktrees.length > 0,
    collab: true,
  };
  const visible: Record<DockSection, boolean> = {
    autophase: (hasData.autophase || dockSection === 'autophase') && !hidden.has('autophase'),
    goal: (hasData.goal || dockSection === 'goal') && !hidden.has('goal'),
    fleet: (hasData.fleet || dockSection === 'fleet') && !hidden.has('fleet'),
    work: (hasData.work || dockSection === 'work') && !hidden.has('work'),
    worktrees: (hasData.worktrees || dockSection === 'worktrees') && !hidden.has('worktrees'),
    collab: (hasData.collab || dockSection === 'collab') && !hidden.has('collab'),
  };
  const open = dockSection && visible[dockSection] ? dockSection : null;

  return (
    <div className="space-y-2">
      {/* ── Chip strip ── */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/70 bg-card/70 px-2 py-1.5 shadow-sm">
        {visible.autophase && (
          <DockChip
            section="autophase"
            icon={<Rocket className="h-3 w-3" />}
            label="AutoPhase"
            value={`${overallPercent}%`}
            active={false}
            pulse={activePhaseId != null}
            // AutoPhase opens straight into the full board view — the inline
            // panel hogged vertical space above the chat history.
            onClick={() => openMainView('autophase')}
          />
        )}
        {visible.goal && goal && (
          <DockChip
            section="goal"
            icon={<Target className="h-3 w-3" />}
            label="Goal"
            value={`${goal.progress}%`}
            active={open === 'goal'}
            pulse={goal.goalState === 'active'}
            onClick={() => toggleDockSection('goal')}
          />
        )}
        {visible.fleet && (
          <DockChip
            section="fleet"
            icon={<Bot className="h-3 w-3" />}
            label="Fleet"
            value={`${fleetRunning}/${fleetTotal}`}
            active={open === 'fleet'}
            pulse={fleetRunning > 0}
            onClick={() => toggleDockSection('fleet')}
          />
        )}
        <DockChip
          section="work"
          icon={<ListTodo className="h-3 w-3" />}
          label="Work"
          value={todos.length > 0 ? `${todosDone}/${todos.length}` : undefined}
          active={open === 'work'}
          pulse={todosActive}
          onClick={() => toggleDockSection('work')}
        />
        {visible.worktrees && (
          <DockChip
            section="worktrees"
            icon={<GitBranch className="h-3 w-3" />}
            label="Worktrees"
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
              <span className="text-success" title={t('activity:dock.ahead', { count: gitInfo.ahead })}>
                ↑{gitInfo.ahead}
              </span>
            )}
            {gitInfo.behind > 0 && (
              <span className="text-warning" title={t('activity:dock.behind', { count: gitInfo.behind })}>
                ↓{gitInfo.behind}
              </span>
            )}
            {gitInfo.added > 0 && (
              <span className="text-success" title={t('activity:dock.linesAdded', { count: gitInfo.added })}>
                +{gitInfo.added}
              </span>
            )}
            {gitInfo.deleted > 0 && (
              <span className="text-destructive" title={t('activity:dock.linesDeleted', { count: gitInfo.deleted })}>
                -{gitInfo.deleted}
              </span>
            )}
            {gitInfo.untracked > 0 && (
              <span className="text-muted-foreground" title={t('activity:dock.untrackedFiles', { count: gitInfo.untracked })}>
                {gitInfo.untracked}?
              </span>
            )}
          </button>
        )}
        <DockChip
          section="collab"
          icon={<Users className="h-3 w-3" />}
          label="Collab"
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

      {/* ── Expanded section — exactly one, or nothing ── */}
      {open && <div className="border-t border-border/40 pt-2" />}
      {open === 'goal' && (
        goal ? (
          <GoalPanel goal={goal} />
        ) : (
          <DockEmptyState title={t('activity:dock.noActiveGoal')} detail={t('activity:dock.noActiveGoalDetail')} />
        )
      )}
      {open === 'fleet' && <FleetPanel />}
      {open === 'worktrees' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {(['graph', 'lanes'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setWorktreeView(v)}
                className={cn(
                  'text-xs px-2.5 py-0.5 rounded-md border transition-colors capitalize',
                  worktreeView === v
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
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
      {/* Work + Collab stay mounted so their WS subscriptions survive. */}
      <div className={cn(open === 'work' ? 'block' : 'hidden')} id="panel-work">
        <WorkDashboard />
      </div>
      <div className={cn(open === 'collab' ? 'block' : 'hidden')}>
        <CollabPanel sessionId={sessionId} />
      </div>
    </div>
  );
}

function DockEmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 text-muted-foreground">{detail}</div>
    </div>
  );
}
