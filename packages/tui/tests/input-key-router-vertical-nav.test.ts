import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_PROMPT, inputContentWidth, type KeyEvent } from '../src/components/input.js';
import { routeInputKey, type InputKeyRouterHost } from '../src/input-key-router.js';
import { layoutInputRows } from '../src/input-tokens.js';

/**
 * Regression: the Up/Down/PgUp/PgDn walk compared cell-space offsets against
 * the buffer-space cursor. layoutInputRows places the caret cell at flat cell
 * index `prompt.length + cursor`, so with the production prompt (`❯ `) every
 * vertical move landed prompt.length columns left — and could target the
 * wrong row entirely (Down from row 1 col 0 stayed on row 1). The walk now
 * locates the cursor cell the layout already marks.
 */

const WIDTH = inputContentWidth(80);
const BUFFER =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi ' +
  'rho sigma tau upsilon phi chi psi omega alpha beta gamma delta epsilon zeta eta theta ' +
  'iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega';

function caretPos(buffer: string, cursor: number, prompt: string): { row: number; col: number } {
  const rows = layoutInputRows(prompt, buffer, cursor, WIDTH);
  for (let row = 0; row < rows.length; row++) {
    const cells = rows[row] ?? [];
    for (let col = 0; col < cells.length; col++) {
      if (cells[col]?.cursor) return { row, col };
    }
  }
  throw new Error('no caret cell found');
}

function makeHost(
  buffer: string,
  cursor: number,
  prompt: string,
): { host: InputKeyRouterHost; drafts: Array<{ buffer: string; cursor: number }> } {
  const drafts: Array<{ buffer: string; cursor: number }> = [];
  return {
    drafts,
    host: {
      state: { status: 'idle', inputHistory: [], historyIndex: 0 },
      draft: { buffer, cursor },
      overlayOpen: false,
      prompt,
      terminalColumns: 80,
      terminalRows: 24,
      nextSteps: {
        timer: { current: undefined },
        suggestion: { current: null },
        label: null,
        setCountdown: () => {},
        setLabel: () => {},
        cancel: () => {},
      },
      dispatch: () => {},
      setDraft: (b, c) => drafts.push({ buffer: b, cursor: c }),
      pasteClipboardText: async () => {},
      pasteClipboardImage: async () => {},
      commitPaste: async () => {},
    },
  };
}

function arrowKey(dir: 'upArrow' | 'downArrow' | 'pageDown'): KeyEvent {
  return {
    upArrow: dir === 'upArrow',
    downArrow: dir === 'downArrow',
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    meta: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    pageUp: false,
    pageDown: dir === 'pageDown',
    home: false,
    end: false,
  };
}

async function press(
  buffer: string,
  cursor: number,
  dir: 'upArrow' | 'downArrow' | 'pageDown',
  prompt: string = DEFAULT_INPUT_PROMPT,
): Promise<{ row: number; col: number }> {
  const { host, drafts } = makeHost(buffer, cursor, prompt);
  await routeInputKey(host, '', arrowKey(dir));
  const next = drafts[0];
  return next ? caretPos(next.buffer, next.cursor, prompt) : caretPos(buffer, cursor, prompt);
}

describe('input vertical navigation with the production prompt', () => {
  it('Down from row 1 col 0 moves to row 2 col 0', async () => {
    expect(caretPos(BUFFER, 74, DEFAULT_INPUT_PROMPT)).toEqual({ row: 1, col: 0 });
    expect(await press(BUFFER, 74, 'downArrow')).toEqual({ row: 2, col: 0 });
  });

  it('Up from row 2 col 0 moves to row 1 col 0', async () => {
    expect(await press(BUFFER, 150, 'upArrow')).toEqual({ row: 1, col: 0 });
  });

  it('Down on the last row consumes the key without moving', async () => {
    expect(await press(BUFFER, 226, 'downArrow')).toEqual(caretPos(BUFFER, 226, DEFAULT_INPUT_PROMPT));
    const { host, drafts } = makeHost(BUFFER, 226, DEFAULT_INPUT_PROMPT);
    expect(await routeInputKey(host, '', arrowKey('downArrow'))).toBe(true);
    expect(drafts).toHaveLength(0);
  });

  it('caret on a newline cell: Down moves to the following row', async () => {
    expect(await press('ab\ncd', 2, 'downArrow')).toEqual({ row: 1, col: 2 });
  });

  it('PageDown from the first row jumps to the last row', async () => {
    expect((await press(BUFFER, 74, 'pageDown')).row).toBe(3);
  });

  it('stays correct for an empty prompt (legacy walk boundary)', async () => {
    expect(await press(BUFFER, 76, 'downArrow', '')).toEqual({ row: 2, col: 0 });
  });
});
