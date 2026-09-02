import type { EventBus } from '@wrongstack/core/kernel';
import type { SddBoardSnapshot } from '@wrongstack/sdd';
import { useCallback, useEffect } from 'react';
import type { Action, State } from '../app-reducer.js';
import { useBrainEvents } from './use-brain-events.js';
import { useSubagentEvents } from './use-subagent-events.js';

type ClearHistoryDispatch = React.Dispatch<
  | { type: 'clearHistory'; model?: string | undefined; provider?: string | undefined }
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
  useSessionEvents(events, dispatch, onClearHistory, getSessionId);
  useBrainEvents(events, dispatch, getSessionId);
  useGoalEvents(subscribeGoal, dispatch, stateRef, getSessionId);
}

function useSessionEvents(
  events: EventBus,
  dispatch: React.Dispatch<Action>,
  onClearHistory?: ((dispatch: ClearHistoryDispatch) => void) | undefined,
  getSessionId?: (() => string | undefined) | undefined,
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
      dispatch({ type: 'clearHistory' });
      dispatch({ type: 'resetContextChip' });
      onClearHistory?.(dispatch);
    });
    return () => {
      offCheckpoint();
      offRewound();
    };
  }, [events, dispatch, onClearHistory, getSessionId]);
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
      switch (event) {
        case 'phase.started': {
          const p = payload as { phaseId: string; name: string };
          dispatch({
            type: 'goalRunPhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'running',
            completedTasks: 0,
            totalTasks: 0,
            startedAt: Date.now(),
          });
          break;
        }
        case 'phase.completed': {
          const p = payload as { phaseId: string; name: string };
          dispatch({
            type: 'goalRunPhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'completed',
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.failed': {
          const p = payload as { phaseId: string; name: string };
          dispatch({
            type: 'goalRunPhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'failed',
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.statusChange': {
          const p = payload as { phaseId: string; name: string; to: string };
          const status = p.to === 'running' ? 'running' : p.to;
          dispatch({
            type: 'goalRunPhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status,
            completedTasks: 0,
            totalTasks: 0,
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
          const active = stateRef.current.goalRun?.phases[p.phaseId]?.activeTasks?.find(
            (t) => t.taskId === p.taskId,
          );
          if (active) {
            dispatch({
              type: 'goalRunTaskActive',
              phaseId: p.phaseId,
              taskId: p.taskId,
              title: active.title,
              agent: p.agentName,
              active: true,
            });
          }
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
          const existing = stateRef.current.goalRun?.phases[p.phaseId];
          if (existing) {
            dispatch({
              type: 'goalRunPhaseUpdate',
              phaseId: p.phaseId,
              name: existing.name,
              status: existing.status,
              completedTasks: existing.completedTasks + 1,
              totalTasks: existing.totalTasks,
            });
          }
          dispatch({
            type: 'goalRunTaskActive',
            phaseId: p.phaseId,
            taskId: p.taskId,
            title: '',
            active: false,
          });
          break;
        }
        case 'autonomous.tick': {
          const p = payload as {
            activePhases: Array<{ id: string }>;
          };
          dispatch({ type: 'goalRunRunningPhases', phaseIds: p.activePhases.map((ph) => ph.id) });
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
          dispatch({ type: 'goalRunReset' });
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
