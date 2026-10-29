/** The editor text after a keystroke and the selection to restore. */
export interface TextEdit {
  text: string;
  start: number;
  end: number;
}

/** Tabs when most indented lines start with a tab, otherwise two spaces. */
export function indentUnit(text: string): string {
  let tabs = 0,
    spaces = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) tabs++;
    else if (line.startsWith(' ')) spaces++;
  }
  return tabs > spaces ? '\t' : '  ';
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;

/**
 * Enter keeps the current line's leading whitespace, plus one unit after an opening bracket.
 * Between a bracket pair the closing bracket moves to its own line at the original indent.
 */
export function newlineWithIndent(
  text: string,
  start: number,
  end: number,
  unit: string,
): TextEdit {
  const from = lineStart(text, start);
  const indent = /^[ \t]*/.exec(text.slice(from, start))![0];
  const before = text.slice(0, start).trimEnd().slice(-1),
    after = text.slice(end, end + 1);
  const opens = before === '{' || before === '[' || before === '(';
  const pair =
    (before === '{' && after === '}') ||
    (before === '[' && after === ']') ||
    (before === '(' && after === ')');
  const inner = `\n${indent}${opens ? unit : ''}`;
  const insert = pair ? `${inner}\n${indent}` : inner;
  const caret = start + inner.length;
  return { text: text.slice(0, start) + insert + text.slice(end), start: caret, end: caret };
}

/** Lines touched by a selection; an end at the very start of a line does not include it. */
function touched(text: string, start: number, end: number) {
  const first = lineStart(text, start);
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const close = text.indexOf('\n', last);
  return { first, stop: close < 0 ? text.length : close };
}

/** Tab over a multi-line selection: one unit before every touched line. */
export function indentLines(text: string, start: number, end: number, unit: string): TextEdit {
  const { first, stop } = touched(text, start, end);
  const lines = text.slice(first, stop).split('\n');
  const block = lines.map((line) => (line ? unit + line : line)).join('\n');
  const added = block.length - (stop - first);
  return {
    text: text.slice(0, first) + block + text.slice(stop),
    // A selection starting at the line start keeps the whole line selected.
    start: start === first || !lines[0] ? start : start + unit.length,
    end: end + added,
  };
}

/** Shift+Tab: remove up to one unit (a tab or that many spaces) from every touched line. */
export function outdentLines(text: string, start: number, end: number, unit: string): TextEdit {
  const { first, stop } = touched(text, start, end);
  const width = unit === '\t' ? 1 : unit.length;
  let removedBeforeStart = 0,
    removed = 0,
    offset = first;
  const lines = text
    .slice(first, stop)
    .split('\n')
    .map((line, index) => {
      const cut = line.startsWith('\t')
        ? 1
        : /^ */.exec(line)![0].length >= width
          ? width
          : /^ */.exec(line)![0].length;
      if (index === 0) removedBeforeStart = Math.min(cut, start - offset);
      removed += cut;
      offset += line.length + 1;
      return line.slice(cut);
    });
  return {
    text: text.slice(0, first) + lines.join('\n') + text.slice(stop),
    start: Math.max(first, start - removedBeforeStart),
    end: Math.max(first, end - removed),
  };
}

/**
 * The edit for an indentation keystroke in the code editor, or null to let the textarea handle
 * it: Tab inserts one unit (or indents a multi-line selection), Shift+Tab outdents, and Enter
 * keeps the line indent. IME composition and modified Enter are left alone.
 */
export function editorKeyEdit(
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
): TextEdit | null {
  if (event.nativeEvent?.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  const { selectionStart: start, selectionEnd: end } = event.currentTarget;
  const unit = indentUnit(text);
  if (event.key === 'Tab') {
    if (event.shiftKey) return outdentLines(text, start, end, unit);
    if (text.slice(start, end).includes('\n')) return indentLines(text, start, end, unit);
    const caret = start + unit.length;
    return { text: text.slice(0, start) + unit + text.slice(end), start: caret, end: caret };
  }
  if (event.key === 'Enter' && !event.shiftKey) return newlineWithIndent(text, start, end, unit);
  return null;
}

/** The single range that turns `before` into `after`: common prefix and suffix are kept. */
export function replacementRange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } {
  let from = 0;
  const limit = Math.min(before.length, after.length);
  while (from < limit && before[from] === after[from]) from++;
  let tail = 0;
  while (tail < limit - from && before[before.length - 1 - tail] === after[after.length - 1 - tail])
    tail++;
  return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) };
}
