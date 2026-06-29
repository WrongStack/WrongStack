import type { EventBus, SddBoardSnapshot } from '@wrongstack/core';
import { useEffect } from 'react';
import type { Action, State } from '../app-reducer.js';
import { useBrainEvents } from './use-brain-events.js';
import { useSubagentEvents } from './use-subagent-events.js';

type ClearHistoryDispatch = React.Dispatch<
  | { type: 'clearHistory' }
  | { type: 'resetContextChip' }
  | { type: 'streamReset' }
  | { type: 'toolStreamClear' }
>;

export interface UseTuiEventBridgeOptions {
  events: EventBus;
  dispatch: React.Dispatch<Action>;
  stateRef: React.MutableRefObject<State>;
  setActiveMaxContext: (value: number | undefined) => void;
  getSessionId?: (() => string | undefined) | undefined;
  subscribeAutoPhase?:
    | ((handler: (event: string, payload: unknown) => void) => () => void)
    | undefined;
  onClearHistory?: ((dispatch: ClearHistoryDispatch) => void) | undefined;
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
  subscribeAutoPhase,
  onClearHistory,
}: UseTuiEventBridgeOptions): void {
  useSubagentEvents(events, dispatch, setActiveMaxContext, getSessionId);
  useSessionEvents(events, dispatch, onClearHistory, getSessionId);
  useBrainEvents(events, dispatch, getSessionId);
  useAutoPhaseEvents(subscribeAutoPhase, dispatch, stateRef, getSessionId);
}

function useSessionEvents(
  events: EventBus,
  dispatch: React.Dispatch<Action>,
  onClearHistory?: ((dispatch: ClearHistoryDispatch) => void) | undefined,
  getSessionId?: (() => string | undefined) | undefined,
): void {
  useEffect(() => {
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
      dispatch({ type: 'sessionRewound', toPromptIndex: 0 });
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

function useAutoPhaseEvents(
  subscribeAutoPhase:
    | ((handler: (event: string, payload: unknown) => void) => () => void)
    | undefined,
  dispatch: React.Dispatch<Action>,
  stateRef: React.MutableRefObject<State>,
  getSessionId?: (() => string | undefined) | undefined,
): void {
  useEffect(() => {
    if (!subscribeAutoPhase) return;
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
            type: 'autoPhasePhaseUpdate',
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
            type: 'autoPhasePhaseUpdate',
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
            type: 'autoPhasePhaseUpdate',
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
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status,
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.taskStarted': {
          const p = payload as { phaseId: string; taskId: string; taskTitle: string; agentName?: string };
          dispatch({
            type: 'autoPhaseTaskActive',
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
          const active = stateRef.current.autoPhase?.phases[p.phaseId]?.activeTasks?.find(
            (t) => t.taskId === p.taskId,
          );
          if (active) {
            dispatch({
              type: 'autoPhaseTaskActive',
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
            type: 'autoPhaseTaskActive',
            phaseId: p.phaseId,
            taskId: p.taskId,
            title: '',
            active: false,
          });
          break;
        }
        case 'phase.taskCompleted': {
          const p = payload as { phaseId: string; taskId: string };
          const existing = stateRef.current.autoPhase?.phases[p.phaseId];
          if (existing) {
            dispatch({
              type: 'autoPhasePhaseUpdate',
              phaseId: p.phaseId,
              name: existing.name,
              status: existing.status,
              completedTasks: existing.completedTasks + 1,
              totalTasks: existing.totalTasks,
            });
          }
          dispatch({
            type: 'autoPhaseTaskActive',
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
          dispatch({ type: 'autoPhaseRunningPhases', phaseIds: p.activePhases.map((ph) => ph.id) });
          const autoPhase = stateRef.current.autoPhase;
          if (autoPhase) {
            const firstPhase = autoPhase.phases[Object.keys(autoPhase.phases)[0] ?? ''];
            const elapsed =
              autoPhase.elapsedMs > 0
                ? autoPhase.elapsedMs + 1000
                : Date.now() - (firstPhase?.startedAt ?? Date.now());
            dispatch({ type: 'autoPhaseElapsed', ms: elapsed });
          }
          break;
        }
        case 'graph.completed':
        case 'graph.failed': {
          dispatch({ type: 'autoPhaseReset' });
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
          dispatch({ type: 'countdownTick', remainingSeconds: (payload as { remaining: number }).remaining });
          break;
        }
      }
    };

    return subscribeAutoPhase(handler);
  }, [subscribeAutoPhase, dispatch, stateRef, getSessionId]);
}
