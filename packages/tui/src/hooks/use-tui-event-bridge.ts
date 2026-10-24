import type { EventBus } from '@wrongstack/contracts/kernel';
import { normalizeWorktreeEvent } from '@wrongstack/contracts/types/worktree-timeline';
import type { SddBoardSnapshot } from '@wrongstack/sdd';
import { useCallback, useEffect } from 'react';
import type { Action, State } from '../app-reducer.js';
import { useBrainEvents } from './use-brain-events.js';
import { useSubagentEvents } from './use-subagent-events.js';

type ClearHistoryDispatch = React.Dispatch<
  | {
      type: 'clearHistory';
      model?: string | undefined;
      provider?: string | undefined;
      /**
       * When explicitly `null`, the reducer treats the boot-time restored
       * transcript as discarded and resets `historyBudget`, `autoProceedHold`,
       * and `nextId` to the fresh-boot values. `/clear` passes `null` for
       * all three so the screen genuinely looks like first launch. Pass
       * `undefined` (or omit) to preserve the existing resume-derived
       * budget/hold — the behavior the bridge uses for `session.rewound` /
       * `project.switched`.
       */
      restoredMessages?: readonly unknown[] | null | undefined;
      restoredToolCalls?: readonly unknown[] | null | undefined;
      restoredEvents?: readonly unknown[] | null | undefined;
    }
  | { type: 'resetContextChip' }
  | { type: 'streamReset' }
  | { type: 'toolStreamClear' }
>;

interface UseTuiEventBridgeOptions {
  events: EventBus;
  dispatch: React.Dispatch<Action>;
  stateRef: { current: State };
  setActiveMaxContext: (value: number | undefined) => void;
  getSessionId?: (() => string | undefined) | undefined;
  subscribeGoal?: ((handler: (event: string, payload: unknown) => void) => () => void) | undefined;
  onClearHistory?: ((dispatch: ClearHistoryDispatch) => void) | undefined;
  sessionGenerationRef?: { current: number } | undefined;
}

/**
 * EventBus and host-event subscriptions that mutate TUI state.
 *
 * Keeping this bridge outside App preserves the reducer as the single state
 * writer while taking long-lived subscription wiring out of the render surface.
 */
export function useTuiEventBridge({
  events,
  dispatch,
  stateRef,
  setActiveMaxContext,
  getSessionId,
  subscribeGoal,
  onClearHistory,
  sessionGenerationRef,
}: UseTuiEventBridgeOptions): void {
  // The chat-mode getter reads through stateRef so a live `/agents chat`
  // flip is honored without re-subscribing the event bridge; memoized so
  // it doesn't churn the subscription effect on every render.
  const getChatMode = useCallback(() => stateRef.current.fleetChat, [stateRef]);
  useSubagentEvents(
    events,
    dispatch,
    setActiveMaxContext,
    getSessionId,
    getChatMode,
    sessionGenerationRef,
  );
  useSessionEvents(events, dispatch, onClearHistory, getSessionId, sessionGenerationRef);
  useBrainEvents(events, dispatch, getSessionId);
  useGoalEvents(subscribeGoal, dispatch, stateRef, getSessionId);
}

function useSessionEvents(
  events: EventBus,
  dispatch: React.Dispatch<Action>,
  onClearHistory?: ((dispatch: ClearHistoryDispatch) => void) | undefined,
  getSessionId?: (() => string | undefined) | undefined,
  sessionGenerationRef?: { current: number } | undefined,
): void {
  useEffect(() => {
    // Permissive predicate: events without a sessionId OR with no
    // current session always apply. Distinct from
    // `sidebar-content.tsx`'s exported `isCurrentSession`, which is
    // strict on the rowId argument (returns false when rowId is
    // undefined; falls back to fallbackIsCurrent only when rowId is
    // defined). See commit 295bd53fa.
    const isCurrentSession = (sessionId?: string | undefined): boolean => {
      const current = getSessionId?.();
      return !sessionId || !current || sessionId === current;
    };
    const offCheckpoint = events.on('checkpoint.written', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      dispatch({
        type: 'checkpointReceived',
        cp: {
          promptIndex: e.promptIndex,
          promptPreview: e.promptPreview,
          ts: e.ts,
          fileCount: e.fileCount,
        },
      });
    });
    const offRewound = events.on('session.rewound', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      // Keep the checkpoints at/below the rewind target: hardcoding 0 here made
      // the reducer's `promptIndex <= toPromptIndex` filter discard every
      // checkpoint but #0, so a second /rewind had nothing left to aim at.
      dispatch({ type: 'sessionRewound', toPromptIndex: e.toPromptIndex });
      dispatch({ type: 'clearHistory', keepCheckpoints: true });
      dispatch({ type: 'resetContextChip' });
      // Not the host's `/clear` hook: that drops pending attachments and the
      // checkpoint list, and a rewind keeps both (it hands the prompt back).
      dispatch({ type: 'streamReset' });
      dispatch({ type: 'toolStreamClear' });
    });
    // The CLI commits all context/session paths before publishing this event.
    // The opening banner is a history snapshot, so it must be replaced too.
    const offProject = events.onPattern(
      'project.switched',
      (_event, payload) => {
        if (!payload || typeof payload !== 'object') return;
        const switched = payload as { to?: unknown; sessionId?: string };
        if (
          typeof switched.to !== 'string' ||
          !switched.to ||
          !isCurrentSession(switched.sessionId)
        )
          return;
        if (sessionGenerationRef) sessionGenerationRef.current += 1;
        dispatch({ type: 'clearHistory', cwd: switched.to, sessionId: switched.sessionId });
        dispatch({ type: 'resetContextChip' });
        onClearHistory?.(dispatch);
      },
      'tui-project-switch',
    );
    return () => {
      offCheckpoint();
      offRewound();
      offProject();
    };
  }, [events, dispatch, onClearHistory, getSessionId, sessionGenerationRef]);
}

function useGoalEvents(
  subscribeGoal: ((handler: (event: string, payload: unknown) => void) => () => void) | undefined,
  dispatch: React.Dispatch<Action>,
  stateRef: React.MutableRefObject<State>,
  getSessionId?: (() => string | undefined) | undefined,
): void {
  useEffect(() => {
    if (!subscribeGoal) return;
    // Permissive predicate: events without a sessionId OR with no
    // current session always apply. Distinct from
    // `sidebar-content.tsx`'s exported `isCurrentSession`, which is
    // strict on the rowId argument (returns false when rowId is
    // undefined; falls back to fallbackIsCurrent only when rowId is
    // defined). See commit 295bd53fa.
    const isCurrentSession = (sessionId?: string | undefined): boolean => {
      const current = getSessionId?.();
      return !sessionId || !current || sessionId === current;
    };

    const handler = (event: string, payload: unknown) => {
      const sessionId =
        payload && typeof payload === 'object' && 'sessionId' in payload
          ? (payload as { sessionId?: string | undefined }).sessionId
          : undefined;
      if (!isCurrentSession(sessionId)) return;
      if (event.startsWith('worktree.')) {
        const timelineEvent = normalizeWorktreeEvent(event, payload, Date.now());
        if (timelineEvent) dispatch({ type: 'worktreeTimelineEvent', event: timelineEvent });
      }
      switch (event) {
        case 'phase.started': {
          const p = payload as {
            phaseId: string;
            name: string;
            completedTasks: number;
            totalTasks: number;
          };
          dispatch({
            type: 'goalRunPhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'running',
            completedTasks: Number.isInteger(p.completedTasks) ? p.completedTasks : 0,
            totalTasks: Number.isInteger(p.totalTasks) ? p.totalTasks : 0,
            startedAt: Date.now(),
          });
          break;
        }
        case 'phase.completed': {
          const p = payload as { phaseId: string; name: string };
          const current = stateRef.current.goalRun?.phases[p.phaseId];
          dispatch({
            type: 'goalRunPhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'completed',
            completedTasks: current?.completedTasks ?? 0,
            totalTasks: current?.totalTasks ?? 0,
          });
          break;
        }
        case 'phase.failed': {
          const p = payload as { phaseId: string; name: string };
          const current = stateRef.current.goalRun?.phases[p.phaseId];
          dispatch({
            type: 'goalRunPhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'failed',
            completedTasks: current?.completedTasks ?? 0,
            totalTasks: current?.totalTasks ?? 0,
          });
          break;
        }
        case 'phase.statusChange': {
          const p = payload as { phaseId: string; to: string };
          const current = stateRef.current.goalRun?.phases[p.phaseId];
          if (!current) break;
          const status = p.to === 'running' ? 'running' : p.to;
          dispatch({
            type: 'goalRunPhaseUpdate',
            phaseId: p.phaseId,
            name: current.name,
            status,
            completedTasks: current.completedTasks,
            totalTasks: current.totalTasks,
          });
          break;
        }
        case 'phase.taskStarted': {
          const p = payload as {
            phaseId: string;
            taskId: string;
            taskTitle: string;
            agentName?: string;
          };
          dispatch({
            type: 'goalRunTaskActive',
            phaseId: p.phaseId,
            taskId: p.taskId,
            title: p.taskTitle,
            agent: p.agentName,
            active: true,
          });
          break;
        }
        case 'phase.taskAssigned': {
          const p = payload as { phaseId: string; taskId: string; agentName?: string };
          // The reducer owns the in-place update: looking the task up here via
          // stateRef (render-synced) dropped the agent whenever taskAssigned
          // arrived in the same tick as its taskStarted — the normal fresh-
          // task path, since executeTask assigns synchronously right after
          // the start emit.
          dispatch({
            type: 'goalRunTaskAgent',
            phaseId: p.phaseId,
            taskId: p.taskId,
            agent: p.agentName,
          });
          break;
        }
        case 'phase.taskFailed': {
          const p = payload as { phaseId: string; taskId: string };
          dispatch({
            type: 'goalRunTaskActive',
            phaseId: p.phaseId,
            taskId: p.taskId,
            title: '',
            active: false,
          });
          break;
        }
        case 'phase.taskCompleted': {
          const p = payload as { phaseId: string; taskId: string };
          // The reducer owns the count arithmetic: computing +1 here from
          // stateRef (render-synced) collapsed batched completions into a
          // single increment — the orchestrator's allSettled settlement
          // loop emits several taskCompleted events in one tick.
          dispatch({ type: 'goalRunTaskCompleted', phaseId: p.phaseId, taskId: p.taskId });
          break;
        }
        case 'autonomous.tick': {
          const p = payload as {
            activePhases: string[];
          };
          dispatch({ type: 'goalRunRunningPhases', phaseIds: p.activePhases });
          const goalRun = stateRef.current.goalRun;
          if (goalRun) {
            const firstPhase = goalRun.phases[Object.keys(goalRun.phases)[0] ?? ''];
            const elapsed =
              goalRun.elapsedMs > 0
                ? goalRun.elapsedMs + 1000
                : Date.now() - (firstPhase?.startedAt ?? Date.now());
            dispatch({ type: 'goalRunElapsed', ms: elapsed });
          }
          break;
        }
        case 'graph.completed':
        case 'graph.failed': {
          // Keep the terminal phase snapshot visible for inspection. A new
          // goalRunInit or an explicit session clear replaces it.
          dispatch({ type: 'goalRunRunningPhases', phaseIds: [] });
          break;
        }
        case 'sdd.board.snapshot': {
          const p = payload as { snapshot?: SddBoardSnapshot };
          if (p.snapshot) dispatch({ type: 'sddBoardSnapshot', snapshot: p.snapshot });
          break;
        }
        case 'worktree.allocated': {
          const p = payload as {
            handleId: string;
            ownerLabel: string;
            branch: string;
            baseBranch: string;
          };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            baseBranch: p.baseBranch,
            row: {
              branch: p.branch,
              ownerLabel: p.ownerLabel,
              baseBranch: p.baseBranch,
              status: 'active',
              allocatedAt: Date.now(),
            },
          });
          break;
        }
        case 'worktree.committed': {
          const p = payload as {
            handleId: string;
            insertions: number;
            deletions: number;
            files: number;
          };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            row: {
              insertions: p.insertions,
              deletions: p.deletions,
              files: p.files,
              status: 'committing',
            },
          });
          break;
        }
        case 'worktree.merging': {
          const p = payload as { handleId: string };
          dispatch({ type: 'worktreeUpsert', handleId: p.handleId, row: { status: 'merging' } });
          break;
        }
        case 'worktree.merged': {
          const p = payload as { handleId: string };
          dispatch({ type: 'worktreeUpsert', handleId: p.handleId, row: { status: 'merged' } });
          break;
        }
        case 'worktree.conflict': {
          const p = payload as { handleId: string; conflictFiles: string[] };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            row: { status: 'needs-review', conflictFiles: p.conflictFiles },
          });
          break;
        }
        case 'worktree.failed': {
          const p = payload as { handleId: string };
          dispatch({ type: 'worktreeUpsert', handleId: p.handleId, row: { status: 'failed' } });
          break;
        }
        case 'worktree.released': {
          const p = payload as { handleId: string; kept: boolean };
          if (!p.kept) dispatch({ type: 'worktreeRemove', handleId: p.handleId });
          break;
        }
        case 'countdown.tick': {
          dispatch({
            type: 'countdownTick',
            remainingSeconds: (payload as { remaining: number }).remaining,
          });
          break;
        }
      }
    };

    return subscribeGoal(handler);
  }, [subscribeGoal, dispatch, stateRef, getSessionId]);
}
