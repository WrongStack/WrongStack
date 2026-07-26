import type { ContentBlock } from '@wrongstack/core/types';
import type { HistoryEntry } from './history-entry.js';

export interface QueueItem {
  id: number;
  displayText: string;
  blocks: ContentBlock[];
  /** When true, the item will be refined via model.refine before entering the agent context. */
  shouldRefine?: boolean | undefined;
}

/** A registered slash command matched against the user's current / query. */
export interface SlashCommandMatch {
  name: string;
  description: string;
  argsHint?: string | undefined;
  matchedAlias?: string | undefined;
  isBuiltin: boolean;
  category: 'Run' | 'Session' | 'Inspect' | 'Agent' | 'Config' | 'App';
}

/** Thin view over a SessionSummary for the resume picker. */
export interface ResumeSessionEntry {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string | undefined;
  tokenTotal: number;
  iterationCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
  /** The current session — marked so the picker can disallow resuming into itself. */
  isCurrent?: boolean | undefined;
}

export type DraftEntry = HistoryEntry extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never;

export type GoalSummary = {
  goal: string;
  refinedGoal?: string | undefined;
  goalState: 'active' | 'paused' | 'completed' | 'abandoned';
  iterations: number;
  progress?: number | undefined;
  progressNote?: string | undefined;
  progressTrend?: 'accelerating' | 'steady' | 'stalling' | undefined;
  deliverables?: string[] | undefined;
  lastTask?: string | undefined;
  lastStatus?: string | undefined;
} | null;
