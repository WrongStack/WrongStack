import type { TaskItem } from './TaskBoard';

export interface PhaseItem {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'skipped';
  priority: 'critical' | 'high' | 'medium' | 'low';
  estimateHours: number;
  actualDurationMs?: number | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  progressPercent: number;
  taskCount: number;
  completedTasks: number;
  assignedAgents: string[];
  isActive: boolean;
  /** Full task list for this phase — present when served by the board-aware state. */
  tasks?: TaskItem[] | undefined;
}

export interface PhasePanelProps {
  phases: PhaseItem[];
  /** Active phase ID */
  activePhaseId?: string | undefined;
  /** Called when a phase is clicked */
  onPhaseClick?: ((phaseId: string) => void) | undefined;
  /** Overall progress (0-100) */
  overallPercent: number;
  /** Whether autonomous mode is active */
  autonomous: boolean;
  /** Pause / Resume toggle */
  onToggleAutonomous?: (() => void) | undefined;
  className?: string | undefined;
}
