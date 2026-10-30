import type { TextEdit } from './editor-indent';

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);
const QUOTES = new Set(['"', "'", '`']);
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc|org|tex)$/i;

/** Brackets pair everywhere; quotes pair only outside prose, where apostrophes are common. */
export function pairsQuotes(path: string): boolean {
  return !PROSE.test(path);
}

const word = (char: string | undefined) => !!char && /[\p{L}\p{N}_$]/u.test(char);

/**
 * Typing an opening bracket or quote: wraps a selection, inserts the pair before whitespace or a
 * closing bracket, and types over a closing character that is already next to the caret.
 */
export function pairEdit(
  key: string,
  text: string,
  start: number,
  end: number,
  quotes: boolean,
): TextEdit | null {
  const isQuote = quotes && QUOTES.has(key);
  const close = OPEN[key] ?? (isQuote ? key : undefined);
  const next = text[end];
  if (start === end && (CLOSE.has(key) || isQuote) && next === key)
    return { text, start: start + 1, end: start + 1 };
  if (!close) return null;
  if (start !== end) {
    // A multi-line selection is more likely a paste target than a wrap; leave it alone.
    if (text.slice(start, end).includes('\n')) return null;
    return {
      text: text.slice(0, start) + key + text.slice(start, end) + close + text.slice(end),
      start: start + 1,
      end: end + 1,
    };
  }
  const nextFree =
    next === undefined || /\s/.test(next) || CLOSE.has(next) || next === ',' || next === ';';
  if (!nextFree) return null;
  // A quote after a word character is usually an apostrophe or a closing quote.
  if (isQuote && word(text[start - 1])) return null;
  return {
    text: text.slice(0, start) + key + close + text.slice(end),
    start: start + 1,
    end: start + 1,
  };
}

/** Backspace between an empty pair removes both halves. */
export function backspacePair(
  text: string,
  start: number,
  end: number,
  quotes: boolean,
): TextEdit | null {
  if (start !== end || start === 0) return null;
  const before = text[start - 1]!,
    after = text[start];
  const matches = OPEN[before] === after || (quotes && QUOTES.has(before) && before === after);
  if (!matches) return null;
  return {
    text: text.slice(0, start - 1) + text.slice(start + 1),
    start: start - 1,
    end: start - 1,
  };
}

/** Whole lines touched by a selection, as [first line start, end of last line). */
function lineBlock(text: string, start: number, end: number) {
  const first = text.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const close = text.indexOf('\n', last);
  return { first, stop: close < 0 ? text.length : close };
}

/** Alt+Up / Alt+Down: move the touched lines past the neighbouring line, keeping the selection. */
export function moveLines(
  text: string,
  start: number,
  end: number,
  direction: 'up' | 'down',
): TextEdit | null {
  const { first, stop } = lineBlock(text, start, end);
  const block = text.slice(first, stop);
  if (direction === 'up') {
    if (first === 0) return null;
    const above = text.lastIndexOf('\n', first - 2) + 1;
    const neighbour = text.slice(above, first - 1);
    const shift = neighbour.length + 1;
    return {
      text: `${text.slice(0, above)}${block}\n${neighbour}${text.slice(stop)}`,
      start: start - shift,
      end: end - shift,
    };
  }
  if (stop === text.length) return null;
  const below = text.indexOf('\n', stop + 1);
  const belowEnd = below < 0 ? text.length : below;
  const neighbour = text.slice(stop + 1, belowEnd);
  const shift = neighbour.length + 1;
  return {
    text: `${text.slice(0, first)}${neighbour}\n${block}${text.slice(belowEnd)}`,
    start: start + shift,
    end: end + shift,
  };
}

/** Shift+Alt+Down: duplicate the touched lines below, selecting the copy. */
export function duplicateLines(text: string, start: number, end: number): TextEdit {
  const { first, stop } = lineBlock(text, start, end);
  const block = text.slice(first, stop);
  const shift = block.length + 1;
  return {
    text: `${text.slice(0, stop)}\n${block}${text.slice(stop)}`,
    start: start + shift,
    end: end + shift,
  };
}

/**
 * Pair, line-move and duplicate keystrokes for the code editor, or null to let the textarea or
 * the indentation handler take the key.
 */
export function editorPairEdit(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    nativeEvent?: { isComposing?: boolean };
    currentTarget: { selectionStart: number; selectionEnd: number };
  },
  text: string,
  path: string,
): TextEdit | null {
  if (event.nativeEvent?.isComposing || event.ctrlKey || event.metaKey) return null;
  const { selectionStart: start, selectionEnd: end } = event.currentTarget;
  if (event.altKey) {
    if (event.key === 'ArrowUp' && !event.shiftKey) return moveLines(text, start, end, 'up');
    if (event.key === 'ArrowDown')
      return event.shiftKey
        ? duplicateLines(text, start, end)
        : moveLines(text, start, end, 'down');
    return null;
  }
  const quotes = pairsQuotes(path);
  if (event.key === 'Backspace') return backspacePair(text, start, end, quotes);
  if (event.key.length === 1) return pairEdit(event.key, text, start, end, quotes);
  return null;
}
