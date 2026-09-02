/**
 * TuiRuntimeState — shared mutable context for TUI branch sub-modules.
 *
 * Phase B prerequisite. The TUI branch of `execute()` (lines 603-1905)
 * contains ~1,200 lines of closures that read and write mutable local
 * variables declared at the top of `execute()`:
 *
 *   `projectRoot`, `wpaths`, `activeSessionStore`,
 *   `detachActiveTodosCheckpoint` (in the outer scope)
 *   `pendingProjectSwitch`, `autonomousCoordinator`, `coordinatorRun`,
 *   `coordinatorEvents` (in the TUI branch scope)
 *
 * Extracting sub-modules (coordinator setup, project switch, session
 * resume) requires these mutable bindings to be reachable from outside
 * the `execute()` closure. JavaScript closures can't be partially
 * extracted — a function defined in another file can't reassign a
 * `let` in `execute()`.
 *
 * The pattern is a shared mutable container: each mutable binding
 * becomes a property on a single `TuiRuntimeState` object that the
 * extracted function receives as a parameter. Mutations are written
 * to `state.field = newValue`; the caller (execute) and the extracted
 * module both hold the same object reference, so a mutation by one is
 * visible to the other.
 *
 * Usage in execute():
 *
 *   const state: TuiRuntimeState = {
 *     projectRoot,
 *     wpaths,
 *     activeSessionStore,
 *     detachActiveTodosCheckpoint,
 *     pendingProjectSwitch: null,
 *     autonomousCoordinator: null,
 *     coordinatorRun: null,
 *     coordinatorEvents: new Set(),
 *   };
 *
 *   // ... extracted modules receive `state` and mutate it:
 *   const coordinator = ensureAutonomousCoordinator(state, deps);
 *   // coordinator wrote state.autonomousCoordinator — visible here
 *
 *   // After the TUI branch, sync locals back:
 *   projectRoot = state.projectRoot;
 *   wpaths = state.wpaths;
 *
 * Why not individual `{ current: T }` refs (React-style)?
 *   The outer scope's `finally` block reads these variables (e.g.
 *   `activeSessionStore`, `wpaths`) for cleanup. A single flat object
 *   is simpler to sync back than 8 separate refs, and the mutation
 *   pattern (`.field = x`) is cleaner than `.field.current = x`.
 */
import type { AutonomousCoordinator, CoordinatorEvent } from '@wrongstack/core/coordination';
import type { SessionStore } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { SessionIdentityTarget } from '../wiring/session-registry.js';
import type { PendingProjectSwitch } from './tui-project-spawn.js';

/**
 * The shared mutable runtime state for the TUI dispatch branch.
 *
 * Every field is mutable — extracted modules read AND write these
 * properties. The object is created once in `execute()` and passed
 * to every Phase B sub-module.
 */
export interface TuiRuntimeState {
  // ── Outer-scope mutables (declared at the top of execute()) ───────────

  /** Current project root directory. Mutated by switchProjectInPlace. */
  projectRoot: string;
  /** Resolved WrongStack paths. Mutated by switchProjectInPlace. */
  wpaths: WstackPaths;
  /** Active session store. Mutated by switchProjectInPlace. */
  activeSessionStore: SessionStore | undefined;
  /** Move this process's cross-process ownership after an explicit resume. */
  activateSessionIdentity?:
    | ((sessionId: string, target?: SessionIdentityTarget) => Promise<void>)
    | undefined;
  /** Todos checkpoint detach function. Mutated by switchProjectInPlace. */
  detachActiveTodosCheckpoint: (() => void | Promise<void>) | undefined;
  /**
   * Forward-declared session ref that lives on the cli-main scope. Mutated by
   * `resumeSession()` when an in-process `/resume` swaps the active writer so
   * provider-side `getSessionId: () => sessionRef.current?.id` callbacks and
   * record-mode bindings follow the resumed session instead of staying pinned
   * to the boot session.
   *
   * Optional: tests/hosts that predate the resume refactor can omit it. The
   * resume handler is then a no-op for the ref, leaving provider calls pinned
   * to the boot session — same behavior as before this field existed.
   */
  sessionRef?: { current: import('@wrongstack/core/types').SessionWriter | undefined } | undefined;

  // ── TUI-branch-scope mutables (declared inside the TUI branch) ────────

  /** Pending project switch (F1 picker / F10 sessions). Set by onProjectSelect/onSwitchToSession. */
  pendingProjectSwitch: PendingProjectSwitch | null;
  /** Lazy AutonomousCoordinator. Set by ensureAutonomousCoordinator. */
  autonomousCoordinator: AutonomousCoordinator | null;
  /** In-flight coordinator run promise. Set/cleared by onCoordinatorStart. */
  coordinatorRun: Promise<void> | null;
  /** Coordinator event subscribers. Mutated by subscribeCoordinatorEvents. */
  coordinatorEvents: Set<(event: CoordinatorEvent) => void>;
}
