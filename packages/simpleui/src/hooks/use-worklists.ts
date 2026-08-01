import type { RefObject } from 'react';
import { useCallback, useState } from 'react';
import {
  createWorklistStore,
  type PlanStatus,
  type TaskStatus,
  type TodoStatus,
  type WorklistStore,
  type WorklistView,
} from '../lib/worklist-store.js';
import type { SimpleSocket } from '../lib/ws.js';

export interface UseWorklistsOptions {
  socketRef: RefObject<SimpleSocket | null>;
  sessionIdRef: RefObject<string | null>;
}

export interface UseWorklistsResult {
  /** Live worklist projection (todos / tasks / plan). */
  worklists: WorklistStore;
  /** Refresh a worklist view (todos / tasks / plan) from the server. */
  requestWorklist: (view: WorklistView) => void;
  /**
   * Open the workspace panel for `tools` or a worklist view. Implemented
   * as a bounded `simpleui:open-workspace-panel` CustomEvent so the sidebar
   * keeps its own local state. Stays in this hook because the command
   * palette action dispatcher in the session shell has `openWorkspacePanel`
   * in its `useCallback` deps.
   */
  openWorkspacePanel: (view: 'tools' | WorklistView) => void;
  updateTodoStatus: (id: string, status: TodoStatus) => void;
  updateTaskStatus: (id: string, status: TaskStatus) => void;
  updatePlanStatus: (target: string, status: PlanStatus) => void;
}

/**
 * Owns the SimpleUI worklist projection: the live store, the per-view
 * refresh command, the workspace-panel dispatcher, and the per-row status
 * updates. Extracted from `simple-ui-session.tsx` (plan B1, slice 4).
 *
 * Status updates require an active session id — if the session is gone the
 * call is a no-op. This matches the prior inline behavior so the
 * session-resume edge case isn't a regression.
 *
 * `openWorkspacePanel` lives here because `runCommandPaletteAction` in the
 * session shell has it in its `useCallback` deps.
 */
export function useWorklists(options: UseWorklistsOptions): UseWorklistsResult {
  const { socketRef, sessionIdRef } = options;

  const [worklists] = useState(() => createWorklistStore());

  const requestWorklist = useCallback(
    (view: WorklistView) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      // Exhaustive view→wire-op mapping: an unhandled `WorklistView` member
      // is a compile error (never assert) instead of silently hitting
      // 'plan.get' like the original ternary fallthrough did.
      let requestType: 'todos.get' | 'tasks.get' | 'plan.get';
      switch (view) {
        case 'todos':
          requestType = 'todos.get';
          break;
        case 'tasks':
          requestType = 'tasks.get';
          break;
        case 'plan':
          requestType = 'plan.get';
          break;
        default: {
          const exhaustive: never = view;
          throw new Error(`Unhandled worklist view: ${exhaustive}`);
        }
      }
      socketRef.current?.send(requestType, { sessionId });
    },
    [sessionIdRef, socketRef],
  );

  const openWorkspacePanel = useCallback((view: 'tools' | WorklistView) => {
    window.dispatchEvent(new CustomEvent('simpleui:open-workspace-panel', { detail: { view } }));
  }, []);

  const updateTodoStatus = useCallback(
    (id: string, status: TodoStatus) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) socketRef.current?.send('todo.update', { sessionId, id, status });
    },
    [sessionIdRef, socketRef],
  );

  const updateTaskStatus = useCallback(
    (id: string, status: TaskStatus) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) socketRef.current?.send('task.update', { sessionId, id, status });
    },
    [sessionIdRef, socketRef],
  );

  const updatePlanStatus = useCallback(
    (target: string, status: PlanStatus) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) socketRef.current?.send('plan.item.update', { sessionId, target, status });
    },
    [sessionIdRef, socketRef],
  );

  return {
    worklists,
    requestWorklist,
    openWorkspacePanel,
    updateTodoStatus,
    updateTaskStatus,
    updatePlanStatus,
  };
}
