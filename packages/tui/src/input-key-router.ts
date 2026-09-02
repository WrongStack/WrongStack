import type { Action, State } from './app-reducer.js';
import { inputContentWidth, type KeyEvent } from './components/input.js';
import {
  deleteTokenBackward,
  inputIndexAtRowCol,
  layoutInputRows,
  tokenLengthForward,
} from './input-tokens.js';
import {
  deleteWordBackward,
  deleteWordForward,
  nextInputWordStart,
  previousInputWordStart,
} from './input-editing.js';
import type { MutableCell } from './shared-types.js';

const PASTE_THRESHOLD_CHARS = 200;

export interface InputKeyRouterHost {
  readonly state: Pick<State, 'status' | 'inputHistory' | 'historyIndex'>;
  readonly draft: { readonly buffer: string; readonly cursor: number };
  readonly overlayOpen: boolean;
  readonly prompt: string;
  readonly terminalColumns: number;
  readonly terminalRows: number;
  readonly nextSteps: {
    readonly timer: MutableCell<ReturnType<typeof setInterval> | undefined>;
    readonly suggestion: MutableCell<string | null>;
    readonly label: string | null;
    setCountdown(value: number | null): void;
    setLabel(value: string | null): void;
    cancel(): void;
  };
  dispatch(action: Action): void;
  setDraft(buffer: string, cursor: number): void;
  pasteClipboardText(): Promise<void>;
  pasteClipboardImage(): Promise<void>;
  commitPaste(input: string): Promise<void>;
}

/**
 * Route keys owned by the editable composer after modal/picker/mouse routing.
 * Returns true when the event was consumed. Keeping this controller independent
 * from the App shell makes cursor, history, clipboard, and paste behavior
 * testable without mounting every overlay controller.
 */
export async function routeInputKey(
  host: InputKeyRouterHost,
  input: string,
  key: KeyEvent,
): Promise<boolean> {
  const { buffer, cursor } = host.draft;

  if (key.tab && host.nextSteps.timer.current != null) {
    const pending = host.nextSteps.suggestion.current ?? host.nextSteps.label ?? '';
    clearInterval(host.nextSteps.timer.current);
    host.nextSteps.timer.current = undefined;
    host.nextSteps.setCountdown(null);
    host.nextSteps.setLabel(null);
    host.nextSteps.suggestion.current = null;
    const text = pending.trim();
    if (text) host.setDraft(text, text.length);
    return true;
  }

  if (key.backspace) {
    if (key.ctrl) {
      const result = deleteWordBackward(buffer, cursor);
      if (result) {
        host.nextSteps.cancel();
        host.setDraft(result.buffer, result.cursor);
      }
      return true;
    }
    const token = deleteTokenBackward(buffer, cursor);
    if (token) {
      host.setDraft(token.buffer, token.cursor);
      return true;
    }
    if (cursor > 0) {
      host.nextSteps.cancel();
      host.setDraft(buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor - 1);
    }
    return true;
  }

  if (key.ctrl && input === 'w') {
    const result = deleteWordBackward(buffer, cursor);
    if (result) {
      host.nextSteps.cancel();
      host.setDraft(result.buffer, result.cursor);
    }
    return true;
  }

  if (key.delete) {
    if (key.ctrl) {
      const result = deleteWordForward(buffer, cursor);
      if (result) {
        host.nextSteps.cancel();
        host.setDraft(result.buffer, result.cursor);
      }
      return true;
    }
    if (cursor < buffer.length) {
      const span = tokenLengthForward(buffer, cursor) || 1;
      host.nextSteps.cancel();
      host.setDraft(buffer.slice(0, cursor) + buffer.slice(cursor + span), cursor);
    }
    return true;
  }

  if (key.leftArrow) {
    const nextCursor = key.ctrl ? previousInputWordStart(buffer, cursor) : Math.max(0, cursor - 1);
    if (nextCursor !== cursor) host.setDraft(buffer, nextCursor);
    return true;
  }
  if (key.rightArrow) {
    const nextCursor = key.ctrl
      ? nextInputWordStart(buffer, cursor)
      : Math.min(buffer.length, cursor + 1);
    if (nextCursor !== cursor) host.setDraft(buffer, nextCursor);
    return true;
  }
  if (key.home) {
    host.setDraft(buffer, 0);
    return true;
  }
  if (key.end) {
    host.setDraft(buffer, buffer.length);
    return true;
  }

  if (!host.overlayOpen && (key.upArrow || key.downArrow || key.pageUp || key.pageDown)) {
    const width = inputContentWidth(host.terminalColumns);
    const rows = layoutInputRows(host.prompt, buffer, cursor, width);
    if (rows.length > 1) {
      let row = 0;
      let col = 0;
      let offset = 0;
      outer: for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const cells = rows[rowIndex]!;
        for (let column = 0; column < cells.length; column++) {
          if (offset === cursor) {
            row = rowIndex;
            col = column;
            break outer;
          }
          offset++;
        }
        if (cells.length < width) offset++;
      }

      const targetRow = key.upArrow
        ? Math.max(0, row - 1)
        : key.downArrow
          ? Math.min(rows.length - 1, row + 1)
          : Math.max(
              0,
              Math.min(
                rows.length - 1,
                row + (key.pageUp ? -1 : 1) * Math.max(1, Math.floor(host.terminalRows / 2)),
              ),
            );
      if (targetRow !== row) {
        const targetLength = rows[targetRow]!.filter((cell) => !cell.prompt && !cell.chip).length;
        const target = inputIndexAtRowCol(
          host.prompt,
          buffer,
          width,
          targetRow,
          Math.min(col, targetLength),
        );
        host.setDraft(buffer, target);
      }
      return true; // Always consume when multi-line: prevents Up/Down at the
      // first/last row from falling through to historyUp/historyDown.
    }
  }

  if (key.upArrow) {
    if (!host.overlayOpen && host.state.inputHistory.length > 0) {
      host.dispatch({ type: 'historyUp' });
    }
    return true;
  }
  if (key.downArrow) {
    if (!host.overlayOpen && host.state.historyIndex > 0) {
      host.dispatch({ type: 'historyDown' });
    }
    return true;
  }
  // PgUp/PgDn are not consumed here — multi-line scroll already handled above,
  // and for single-line / at-boundary they should fall through to the default
  // handler (line 235) which returns false (not consumed). In non-mouse-mode
  // no consumer needs these keys; in mouse-mode the overlay scroll handler
  // owns them before reaching this router.

  if (key.ctrl && input === 'a') {
    host.setDraft(buffer, 0);
    return true;
  }
  if (key.ctrl && input === 'e') {
    host.setDraft(buffer, buffer.length);
    return true;
  }
  if (key.ctrl && input === 'u') {
    host.nextSteps.cancel();
    host.setDraft('', 0);
    return true;
  }
  if (key.ctrl && (input === 'd' || input === 'k')) {
    if (cursor < buffer.length) {
      const end =
        input === 'd' ? cursor + (tokenLengthForward(buffer, cursor) || 1) : buffer.length;
      host.nextSteps.cancel();
      host.setDraft(buffer.slice(0, cursor) + buffer.slice(end), cursor);
    }
    return true;
  }

  if (key.ctrl && input === 'v') {
    // Lock paste only while the agent is actively working — the original
    // three-state gate (running / streaming / aborting) is intentional so
    // paste still works in error, queued, and active states.
    if (
      host.state.status === 'running' ||
      host.state.status === 'streaming' ||
      host.state.status === 'aborting'
    ) {
      host.dispatch({
        type: 'addEntry',
        entry: {
          kind: 'info',
          text: 'Input locked — wait for the agent to finish before pasting.',
        },
      });
    } else {
      await host.pasteClipboardText();
    }
    return true;
  }
  if (key.meta && input === 'v') {
    await host.pasteClipboardImage();
    return true;
  }

  if (!input || key.ctrl || key.meta || input.charCodeAt(0) === 0x1b) return false;
  if (input.length > PASTE_THRESHOLD_CHARS || input.includes('\n')) {
    await host.commitPaste(input);
    return true;
  }

  host.nextSteps.cancel();
  host.setDraft(buffer.slice(0, cursor) + input + buffer.slice(cursor), cursor + input.length);
  return true;
}
