import type { KeyEvent } from '../components/input.js';
import type { KeyRouteContext } from '../key-handler-context.js';
import { routeBusyInterruptKey } from '../overlay-key-router.js';

/**
 * Busy-interrupt routes (Ctrl+C escalation + the busy-state interrupt
 * router), moved verbatim from handleKey (decomposition Phase 3 —
 * docs/decomposition-plan.md). Called by the orchestrator at their pinned
 * positions: Ctrl+C before every modal/status guard, the busy router after
 * the panel-close routes.
 */

/**
 * Ctrl+C: THE unconditional escape hatch. Raw-mode terminals
 * (ConPTY/Windows, and any tty in raw mode) deliver Ctrl+C as KEY DATA — no
 * SIGINT is ever generated — so it must be routed into the escalation ladder
 * from here. This check runs BEFORE every modal/status guard on purpose:
 * Ctrl+C has to work precisely when everything else is wedged ('aborting'
 * block, pending confirm panel, enhance overlay, …). The ladder itself is
 * state-aware (cancels open pickers on the first press, aborts + kills the
 * fleet, then exits on the second press, hard-exits on the third).
 */
export function routeCtrlCEscalation(ctx: KeyRouteContext, input: string, key: KeyEvent): boolean {
  if (key.ctrl && (input === 'c' || input === 'C' || input === '\x03')) {
    ctx.runInterruptLadder();
    return true;
  }
  return false;
}

/** Busy-state interrupts: abort confirmation ladder while streaming. */
export function routeBusyInterrupt(ctx: KeyRouteContext, key: KeyEvent): boolean {
  if (
    routeBusyInterruptKey(
      {
        state: ctx.state,
        dismissedAt: ctx.dismissedEscAtRef,
        streamingText: ctx.streamingTextRef,
        confirmExit: ctx.confirmExitRef,
        activeController: ctx.activeCtrlRef,
        dispatch: ctx.dispatch,
        clearPendingConfirms: ctx.clearPendingConfirms,
        liveDirector: ctx.liveDirector,
      },
      key,
    )
  ) {
    return true;
  }
  return false;
}
