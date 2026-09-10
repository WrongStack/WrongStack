import { todosForScreen } from '../resume-load.js';
import { useAppSessionState } from './use-app-session-state.js';
import { useLiveTodos } from './use-live-todos.js';

/**
 * Facade: reducer state + dispatch + session todos.
 *
 * TUI decomposition Phase 4 A1 (docs/decomposition-a0-app-map.md). Wraps
 * `useAppSessionState` verbatim and derives the on-screen todo list
 * (blanked for the length of a `/resume` — see `todosForScreen`).
 *
 * Call-order contract: after `useTuiEnvironmentState`, before the ref
 * spine (`useAppRefSpine`); fixed and unconditional (behavior contract
 * §0.3 of docs/decomposition-plan.md).
 */
export function useAppState(deps: Parameters<typeof useAppSessionState>[0]) {
  const { state, dispatch, layoutStore } = useAppSessionState(deps);
  const sessionTodos = useLiveTodos(deps.agent.ctx);
  // Blanked for the length of a `/resume` — see `todosForScreen`.
  const liveTodos = todosForScreen(sessionTodos, state.resumeLoad);
  return { state, dispatch, layoutStore, sessionTodos, liveTodos };
}
