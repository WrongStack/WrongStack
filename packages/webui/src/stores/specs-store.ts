import { create } from 'zustand';

export interface SpecListItem {
  id: string;
  displayId: string;
  title: string;
  status: string;
  graphId?: string | undefined;
  total: number;
  completed: number;
}

export type BoardTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'failed'
  | 'completed'
  | 'queued'
  | 'cancelled';

export interface BoardTaskItem {
  id: string;
  shortId: string;
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  type: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';
  status: Exclude<BoardTaskStatus, 'queued' | 'cancelled'>;
  displayStatus: BoardTaskStatus;
  deps: string[];
  /** Live worker on this task (set during an active SDD run). */
  agentName?: string | undefined;
  /** Isolated git worktree branch the task runs in. */
  worktreeBranch?: string | undefined;
  /** Epoch ms when a worker started this task. */
  startedAt?: number | undefined;
  /** Epoch ms when this task finished (completed or failed). */
  completedAt?: number | undefined;
  /** Retry attempts so far. */
  retries?: number | undefined;
  /** Per-task model assignment (overrides the run default), if set. */
  model?: string | undefined;
  /** Per-task provider assignment (overrides the run default), if set. */
  provider?: string | undefined;
  /** Per-task fallback model chain (overrides the run default), if set. */
  fallbackModels?: string[] | undefined;
  /** Per-task completion-gate verification command, if set. */
  verificationCommand?: string | undefined;
  /** Completion-gate outcome for the last worker attempt, if verification ran. */
  verificationState?: 'passed' | 'failed' | undefined;
  /** Failure reason when verificationState is 'failed'. */
  verificationDetail?: string | undefined;
}

export interface SpecColumn {
  label: string;
  tasks: BoardTaskItem[];
}

export interface SpecDetail {
  specId: string;
  graphId: string;
  title: string;
  overview: string;
  status: string;
  total: number;
  completed: number;
  running: number;
  pending: number;
  columns: SpecColumn[];
}

interface SpecsState {
  specs: SpecListItem[];
  detail: SpecDetail | null;
  /** Spec whose dependency board is expanded, if any. */
  expandedSpecId: string | null;
  setSpecs: (specs: SpecListItem[]) => void;
  setDetail: (detail: SpecDetail | null) => void;
  setExpanded: (specId: string | null) => void;
}

export const useSpecsStore = create<SpecsState>()((set) => ({
  specs: [],
  detail: null,
  expandedSpecId: null,
  setSpecs: (specs) => set({ specs }),
  setDetail: (detail) => set({ detail }),
  setExpanded: (specId) => set({ expandedSpecId: specId, detail: specId ? null : null }),
}));
