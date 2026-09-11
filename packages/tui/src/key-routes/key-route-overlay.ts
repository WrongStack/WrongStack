import { effectivePanelPositions } from '../app-ui-state.js';
import { writeClipboardText } from '../clipboard.js';
import type { KeyEvent } from '../components/input.js';
import {
  inspectOverlayHeaderActionAt,
  resolveInspectOverlayContent,
} from '../components/inspect-overlay.js';
import { escCloseAction, escSelfOwnedPanelOpen } from '../esc-close-panels.js';
import { actionForFKeyPanel, fKeyEntryFor } from '../f-key-panels.js';
import type { KeyRouteContext } from '../key-handler-context.js';
import {
  routeModalOverlayKey,
  routePanelEscapeKey,
  routeSettingsOverlayKey,
} from '../overlay-key-router.js';
import { sddLifecycleEntry } from '../sdd-lifecycle-entry.js';

const ESC_DOUBLE_PRESS_MS = 1000;

/**
 * Overlay/panel routes, moved verbatim from handleKey (decomposition Phase 3
 * — docs/decomposition-plan.md). Membership delta recorded per D2: the
 * chord (Ctrl+B/Y) and F-key panel toggles, and the SDD board drill-down
 * ride with this route as the panel family (no dedicated slice among the
 * approved route names).
 *
 * Orchestrator call order (pinned): routeModalOverlay → routeDoubleEsc →
 * routeEscClosePanels → routeChordPanels → routeFKeyPanels → routeSddBoard →
 * routeSettingsOverlay → routePanelEscapeRouter.
 */

/** Modal overlays with their own dedicated UI (confirmQueue, enhance,
 * modelPicker, autonomyPicker, settingsPicker, rewindOverlay, helpOpen). */
export function routeModalOverlay(ctx: KeyRouteContext, input: string, key: KeyEvent): boolean {
  if (
    routeModalOverlayKey(
      {
        state: ctx.state,
        enhanceCancelled: ctx.enhanceCancelledRef,
        enhanceController: ctx.enhanceAbortRef,
        inspectPointerAction:
          key.mouse?.kind === 'press' && key.mouse.button === 'left'
            ? inspectOverlayHeaderActionAt(
                ctx.inspectOverlayHeaderRef?.current ?? null,
                key.mouse.x,
                key.mouse.y,
              )
            : null,
        dispatch: ctx.dispatch,
        copyInspectOverlay: () => {
          const overlay = ctx.state.inspectOverlay;
          if (!overlay) return;
          const content = resolveInspectOverlayContent(
            overlay,
            ctx.state.entries,
            ctx.state.toolStream,
          );
          ctx.detach(
            writeClipboardText(content.body).then((copied) => {
              if (copied) ctx.onHistoryCopy?.(overlay.entryId);
            }),
            'Inspect copy',
          );
        },
      },
      input,
      key,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Double-Esc clears the input buffer. When the user presses Esc twice
 * within ESC_DOUBLE_PRESS_MS ms while the buffer is non-empty, clear it.
 * This mirrors the behaviour of bash's Ctrl+C double-press clearing the
 * line, adapted for Esc (no Ctrl needed).
 */
export function routeDoubleEsc(ctx: KeyRouteContext, key: KeyEvent): boolean {
  if (key.escape) {
    const now = Date.now();
    if (ctx.state.buffer.length > 0 && now - ctx.lastEscAtRef.current < ESC_DOUBLE_PRESS_MS) {
      ctx.dispatch({ type: 'clearInput' });
      ctx.lastEscAtRef.current = 0;
      return true;
    }
    ctx.lastEscAtRef.current = now;
  }
  return false;
}

/**
 * Esc closes the topmost panel BEFORE the busy-interrupt ladder. Pressing
 * Esc with a monitor/panel open means "close this panel", not "abort the
 * run and drop the queue" — even mid-stream. Panels whose own useInput owns
 * Esc (kanban's inline prompt, worktree, goal kanban, phase monitor) are
 * only CONSUMED here: the broadcast useInput model delivers the same
 * keypress to their handler, which performs the close/cancel itself. Either
 * way the double-Esc clear-input timer is disarmed — an Esc spent on a panel
 * must not count toward the buffer-wipe double-press. Bash mode owns Esc
 * too — but only after the panel router above, so an open monitor still
 * closes first; exiting the shell composer must NOT read as a
 * busy-interrupt.
 */
export function routeEscClosePanels(ctx: KeyRouteContext, key: KeyEvent): boolean {
  if (key.escape) {
    const panelClose = escCloseAction(ctx.state);
    if (panelClose) {
      ctx.dispatch(panelClose);
      ctx.lastEscAtRef.current = 0;
      return true;
    }
    if (escSelfOwnedPanelOpen(ctx.state)) {
      ctx.lastEscAtRef.current = 0;
      return true;
    }
    if (ctx.state.bashMode) {
      ctx.dispatch({ type: 'bashModeExit' });
      ctx.lastEscAtRef.current = 0;
      return true;
    }
  }
  return false;
}

/**
 * Monitor-overlay chords. Ctrl+F/G/T are the primary chords; F2/F3/F4 are
 * terminal-safe aliases because some terminals intercept the chord before it
 * reaches the app (notably Windows Terminal eats Ctrl+F for "Find"). Ctrl+B
 * opens the SDD board, Ctrl+Y the project kanban (chord-only — no F-key
 * alias; Ctrl+J is unsuitable because Ink 7 special-cases 0x0A as Enter).
 */
export function routeChordPanels(ctx: KeyRouteContext, input: string, key: KeyEvent): boolean {
  if (key.ctrl && input === 'b') {
    ctx.dispatch({ type: 'toggleSddBoardMonitor' });
    return true;
  }
  if (key.ctrl && input === 'y') {
    ctx.dispatch({ type: 'toggleKanbanPanel' });
    return true;
  }
  return false;
}

/**
 * F-key / Ctrl-alias dispatch — table-driven via fKeyEntryFor. Entries with
 * hostAction need host-side work; the rest dispatch directly via
 * actionForFKeyPanel.
 */
export function routeFKeyPanels(ctx: KeyRouteContext, input: string, key: KeyEvent): boolean {
  const fKeyMatched = fKeyEntryFor(key.fn, key.ctrl, input);
  if (fKeyMatched) {
    const entry = fKeyMatched;
    switch (entry.hostAction) {
      case 'openProjectPicker': {
        if (ctx.state.projectPicker.open) {
          ctx.dispatch({ type: 'projectPickerClose' });
        } else {
          ctx.dispatch({ type: 'closeAllPanels' });
          ctx.openProjectPicker();
        }
        return true;
      }
      case 'loadLiveSessions': {
        if (!ctx.state.sessionsPanelOpen) {
          ctx.dispatch({ type: 'toggleSessionsPanel' });
          ctx.loadLiveSessions();
        } else {
          ctx.dispatch({ type: 'toggleSessionsPanel' });
        }
        return true;
      }
      case 'openStatuslinePicker': {
        ctx.openStatuslinePicker();
        return true;
      }
      case undefined: {
        const action = actionForFKeyPanel(entry, ctx.statuslineHiddenItems);
        if (action) {
          ctx.dispatch(action);
          return true;
        }
        break;
      }
    }
  }
  return false;
}

/**
 * SDD board drill-down. While the SDD board overlay is open, ←/→ drive the
 * per-phase drill-down and `c`/`z`/`x` drive run lifecycle — clean
 * worktrees / rollback commits / destroy. The lifecycle shortcuts MUST be
 * gated on an empty input draft (and bash mode opts out entirely):
 * otherwise typing literal letters in chat would silently fire destructive
 * lifecycle ops.
 */
export function routeSddBoard(ctx: KeyRouteContext, input: string, key: KeyEvent): boolean {
  if (
    ctx.state.sddBoard?.monitorOpen &&
    !key.ctrl &&
    !key.meta &&
    ctx.draftRef.current.buffer === '' &&
    !ctx.state.bashMode
  ) {
    if (key.rightArrow) {
      ctx.dispatch({ type: 'sddBoardFocusNext' });
      return true;
    }
    if (key.leftArrow) {
      ctx.dispatch({ type: 'sddBoardFocusPrev' });
      return true;
    }
    if (input === 'c' || input === 'z' || input === 'x') {
      // c = clean worktrees · z = rollback merged commits · x = destroy.
      // Prefer the live run control (it self-refuses while running and works
      // between stop and registry-clear); fall back to the host's disk-backed
      // applySddLifecycle so the keys keep working once the run has finished.
      const op = input === 'c' ? 'cleanup_worktrees' : input === 'z' ? 'rollback' : 'destroy';
      const run = ctx.getSddRun?.();
      if (op !== 'destroy' && run) {
        const fn = op === 'cleanup_worktrees' ? run.cleanupWorktrees() : run.rollback();
        // A locked worktree or dirty index rejects here.
        ctx.detach(
          Promise.resolve(fn).then((r) => {
            ctx.dispatch({ type: 'addEntry', entry: sddLifecycleEntry(op, r) });
          }),
          `SDD ${op}`,
        );
        return true;
      }
      if (ctx.onSddLifecycle) {
        ctx.detach(
          ctx.onSddLifecycle(op).then((r) => {
            ctx.dispatch({ type: 'addEntry', entry: sddLifecycleEntry(op, r) });
          }),
          `SDD ${op}`,
        );
      } else {
        ctx.dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'SDD lifecycle is not available in this session.' },
        });
      }
      return true;
    }
  }
  return false;
}

/** The settings overlay owns keys while open (routed before panels). */
export function routeSettingsOverlay(
  ctx: KeyRouteContext,
  input: string,
  key: KeyEvent,
  isEnter: boolean,
): boolean {
  if (
    routeSettingsOverlayKey(
      {
        state: ctx.state,
        getSettings: ctx.getSettings,
        saveSettings: ctx.saveSettings,
        lastEnterAt: ctx.lastEnterAtRef,
        dispatch: ctx.dispatch,
      },
      input,
      key,
      isEnter,
    )
  ) {
    return true;
  }
  return false;
}

/** Panel Escape router (bottom-routed process list etc.). */
export function routePanelEscapeRouter(ctx: KeyRouteContext, key: KeyEvent): boolean {
  if (
    routePanelEscapeKey(
      ctx.state,
      key,
      ctx.dispatch,
      effectivePanelPositions(ctx.state, ctx.getSettings?.()).processList !== 'sidebar',
    )
  ) {
    return true;
  }
  return false;
}
