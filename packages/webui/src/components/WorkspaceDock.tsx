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

import { Bot, GitBranch, ListTodo, Maximize2, Rocket, SlidersHorizontal, Target, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
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
import { PhasePanel } from './PhasePanel';
import { Button } from './ui/button';
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

// ── Chip ──────────────────────────────────────────────────────────────

const CHIP_TONES: Record<DockSection, { active: string; idle: string }> = {
  autophase: {
    active: 'bg-primary/15 border-primary/40 text-primary',
    idle: 'text-primary/80 hover:bg-primary/10',
  },
  goal: {
    active: 'bg-rose-500/15 border-rose-500/40 text-rose-600 dark:text-rose-400',
    idle: 'text-rose-600/80 dark:text-rose-400/80 hover:bg-rose-500/10',
  },
  fleet: {
    active: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
    idle: 'text-emerald-600/80 dark:text-emerald-400/80 hover:bg-emerald-500/10',
  },
  work: {
    active: 'bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-400',
    idle: 'text-amber-600/80 dark:text-amber-400/80 hover:bg-amber-500/10',
  },
  worktrees: {
    active: 'bg-violet-500/15 border-violet-500/40 text-violet-600 dark:text-violet-400',
    idle: 'text-violet-600/80 dark:text-violet-400/80 hover:bg-violet-500/10',
  },
  collab: {
    active: 'bg-cyan-500/15 border-cyan-500/40 text-cyan-600 dark:text-cyan-400',
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
  return (
    <button
      type="button"
      onClick={onClick}
      title={active ? `Collapse ${label}` : `Expand ${label}`}
      className={cn(
        'flex items-center gap-2 h-7 px-2.5 rounded-full border text-xs font-medium shrink-0 transition-colors',
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
  const { selectAutoPhase, toggleAutoPhaseAutonomous } = useWebSocket();

  const dockSection = useUIStore((s) => s.dockSection);
  const toggleDockSection = useUIStore((s) => s.toggleDockSection);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const hiddenChips = useUIStore((s) => s.hiddenChips);
  const toggleChipHidden = useUIStore((s) => s.toggleChipHidden);

  const goal = useGoalStore((s) => s.goal);
  const autoPhase = useAutoPhaseStore((s) => s);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);
  const todos = useSessionStore((s) => s.todos);
  const fleetAgents = useFleetStore((s) => s.agents);

  const gitInfo = useGitInfo();

  // Handlers for PhasePanel
  const handlePhaseClick = useCallback(
    (phaseId: string) => selectAutoPhase(phaseId),
    [selectAutoPhase],
  );
  const handleToggleAutonomous = useCallback(
    () => toggleAutoPhaseAutonomous(!autoPhase.autonomous),
    [toggleAutoPhaseAutonomous, autoPhase.autonomous],
  );

  const [worktreeView, setWorktreeView] = useState<'graph' | 'lanes'>('graph');

  const fleetTotal = fleetAgents.size;
  const fleetRunning = useMemo(
    () => Array.from(fleetAgents.values()).filter((a) => a.status === 'running').length,
    [fleetAgents],
  );
  const todosDone = todos.filter((t) => t.status === 'completed').length;
  const todosActive = todos.some((t) => t.status === 'in_progress');
  const phasesActive = autoPhase.phases.length > 0;

  // Auto-open AutoPhase the moment a run starts (0 → N phases) so progress
  // is visible without hunting; auto-collapse when it disappears.
  const prevPhaseCount = useRef(autoPhase.phases.length);
  useEffect(() => {
    const ui = useUIStore.getState();
    if (prevPhaseCount.current === 0 && autoPhase.phases.length > 0 && ui.dockSection === null) {
      ui.setDockSection('autophase');
    }
    if (autoPhase.phases.length === 0 && ui.dockSection === 'autophase') {
      ui.setDockSection(null);
    }
    prevPhaseCount.current = autoPhase.phases.length;
  }, [autoPhase.phases.length]);

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
    autophase: hasData.autophase && !hidden.has('autophase'),
    goal: hasData.goal && !hidden.has('goal'),
    fleet: hasData.fleet && !hidden.has('fleet'),
    work: hasData.work && !hidden.has('work'),
    worktrees: hasData.worktrees && !hidden.has('worktrees'),
    collab: hasData.collab && !hidden.has('collab'),
  };
  const open = dockSection && visible[dockSection] ? dockSection : null;

  return (
    <div className="space-y-2">
      {/* ── Chip strip ── */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 px-2 py-1.5">
        {visible.autophase && (
          <DockChip
            section="autophase"
            icon={<Rocket className="h-3 w-3" />}
            label="AutoPhase"
            value={`${autoPhase.overallPercent}%`}
            active={open === 'autophase'}
            pulse={autoPhase.activePhaseId != null}
            onClick={() => toggleDockSection('autophase')}
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
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border/40 text-xs font-mono hover:bg-muted/60 transition-colors"
          >
            <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="font-semibold text-foreground">{gitInfo.branch}</span>
            {gitInfo.ahead > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400" title={`${gitInfo.ahead} ahead`}>
                ↑{gitInfo.ahead}
              </span>
            )}
            {gitInfo.behind > 0 && (
              <span className="text-amber-600 dark:text-amber-400" title={`${gitInfo.behind} behind`}>
                ↓{gitInfo.behind}
              </span>
            )}
            {gitInfo.added > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400" title={`${gitInfo.added} lines added`}>
                +{gitInfo.added}
              </span>
            )}
            {gitInfo.deleted > 0 && (
              <span className="text-red-600 dark:text-red-400" title={`${gitInfo.deleted} lines deleted`}>
                -{gitInfo.deleted}
              </span>
            )}
            {gitInfo.untracked > 0 && (
              <span className="text-muted-foreground" title={`${gitInfo.untracked} untracked files`}>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Customize dock chips"
              className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-full border border-border/40 text-muted-foreground hover:bg-muted/60 transition-colors shrink-0"
            >
              <SlidersHorizontal className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Dock chips</DropdownMenuLabel>
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
      {open === 'autophase' && phasesActive && (
        <div className="space-y-1.5">
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => setCurrentView('autophase')}
            >
              <Maximize2 className="h-3 w-3" />
              Full view
            </Button>
          </div>
          <PhasePanel
            phases={autoPhase.phases}
            activePhaseId={autoPhase.activePhaseId ?? undefined}
            overallPercent={autoPhase.overallPercent}
            autonomous={autoPhase.autonomous}
            onPhaseClick={handlePhaseClick}
            onToggleAutonomous={handleToggleAutonomous}
            className="w-72 shrink-0"
          />
        </div>
      )}
      {open === 'goal' && <GoalPanel goal={goal} />}
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
                  'text-xs px-2.5 py-0.5 rounded-full border transition-colors capitalize',
                  worktreeView === v
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
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
