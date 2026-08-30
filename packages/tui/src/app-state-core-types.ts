import type { ContentBlock } from '@wrongstack/core/types';
import type { HistoryEntry } from './history-entry.js';

export interface QueueItem {
  id: number;
  displayText: string;
  blocks: ContentBlock[];
  /** When true, the item will be refined via model.refine before entering the agent context. */
  shouldRefine?: boolean | undefined;
  /**
   * Raw (pre-refinement) user text for prompt-journal provenance. Stamped
   * into `ctx.meta[PROMPT_JOURNAL_RAW_MARKER]` by the queue drainer right
   * before the item runs — NOT at enqueue time — so each queued item keeps
   * its own raw text and clearing the queue can never orphan a stale marker.
   */
  journalRaw?: string | undefined;
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
  name?: string | undefined;
  lastUserMessage?: string | undefined;
  messageCount?: number | undefined;
  lastActivityAt?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  tokenTotal: number;
  iterationCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
  /** The current session — marked so the picker can disallow resuming into itself. */
  isCurrent?: boolean | undefined;
  /**
   * Another process is writing this session RIGHT NOW.
   *
   * Taken from the cross-process `SessionRegistry` at listing time, so it
   * covers every surface that claims a session lease — another `wstack --tui`,
   * a WebUI server, SimpleUI, a plain REPL. Two processes appending to one
   * journal interleave their turns and corrupt the transcript, so the picker
   * refuses these outright rather than letting the host's reservation fail
   * seconds into a multi-hundred-MB read.
   *
   * The F10 sessions panel has always had this (it lists live sessions and
   * checks `pid`); the `/resume` picker was built off session SUMMARIES, which
   * carry no liveness at all, so it had no way to know.
   */
  live?: { pid: number; clientType?: string | undefined } | undefined;
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
