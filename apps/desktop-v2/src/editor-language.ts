import { lineCommentMarker, toggleLineComment } from './editor-comment';
import {
  editorKeyEdit,
  indentLines,
  indentUnit,
  newlineWithIndent,
  outdentLines,
  type TextEdit,
} from './editor-indent';
import { editorPairEdit } from './editor-pairs';

type EditorKey = Parameters<typeof editorKeyEdit>[0];

const extensionOf = (path: string) => {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
};

/** Languages whose blocks open with a trailing colon. */
const COLON_BLOCKS = new Set(['py', 'pyi', 'yaml', 'yml']);
/** Python statements after which the next line leaves the block. */
const PY_EXIT = /^\s*(return|pass|break|continue|raise)\b/;

/**
 * The block comment markers for languages without a line comment, or for which the block form
 * is the only comment there is (CSS, HTML/XML, Markdown).
 */
export function blockCommentMarkers(path: string): [string, string] | null {
  const extension = extensionOf(path);
  if (['css', 'scss', 'less'].includes(extension)) return ['/*', '*/'];
  if (['html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'md', 'markdown'].includes(extension))
    return ['<!--', '-->'];
  return null;
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;

/** The touched lines of a selection, as offsets [first, stop). */
function touchedLines(text: string, start: number, end: number) {
  const first = lineStart(text, start);
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const close = text.indexOf('\n', last);
  return { first, stop: close < 0 ? text.length : close };
}

/**
 * Wraps the touched lines in a block comment, or removes the markers when the touched text is
 * already one block comment. The selection keeps covering the same text.
 */
export function toggleBlockComment(
  text: string,
  start: number,
  end: number,
  [open, close]: [string, string],
): TextEdit {
  const { first, stop } = touchedLines(text, start, end);
  const block = text.slice(first, stop);
  const indent = /^[ \t]*/.exec(block)![0];
  const body = block.slice(indent.length).trimEnd();
  if (body.startsWith(open) && body.endsWith(close) && body.length >= open.length + close.length) {
    const inner = body.slice(open.length, body.length - close.length);
    const trimmed = inner.replace(/^ /, '').replace(/ $/, '');
    const next = indent + trimmed + block.slice(indent.length + body.length);
    const lead = open.length + (inner.startsWith(' ') ? 1 : 0);
    const clamp = (offset: number) =>
      Math.min(first + next.length, Math.max(first + indent.length, offset - lead));
    return {
      text: text.slice(0, first) + next + text.slice(stop),
      start: clamp(start),
      end: clamp(end),
    };
  }
  if (!block.trim()) return { text, start, end };
  const next = `${indent}${open} ${block.slice(indent.length)} ${close}`;
  const shift = open.length + 1;
  return {
    text: text.slice(0, first) + next + text.slice(stop),
    start: start <= first + indent.length ? start : start + shift,
    end: end + shift,
  };
}

/** Ctrl+Shift+K: removes the touched lines and their line break. */
export function deleteLines(text: string, start: number, end: number): TextEdit {
  const { first, stop } = touchedLines(text, start, end);
  const from = stop < text.length ? first : Math.max(0, first - 1);
  const to = stop < text.length ? stop + 1 : stop;
  return { text: text.slice(0, from) + text.slice(to), start: from, end: from };
}

/** Home moves to the first non-blank character, or to the line start when already there. */
export function smartHome(text: string, caret: number): number {
  const from = lineStart(text, caret);
  const content = from + /^[ \t]*/.exec(text.slice(from))![0].length;
  return caret === content ? from : content;
}

/**
 * Enter with language knowledge, or null for the generic indentation rule: a doc comment
 * continues with ` * `, and in colon-block languages a trailing colon opens a block while a
 * Python exit statement leaves it.
 */
export function languageNewline(
  text: string,
  start: number,
  end: number,
  path: string,
): TextEdit | null {
  const from = lineStart(text, start);
  const line = text.slice(from, start);
  const indent = /^[ \t]*/.exec(line)![0];
  const unit = indentUnit(text);
  const extension = extensionOf(path);
  const insert = (value: string): TextEdit => {
    const caret = start + value.length;
    return { text: text.slice(0, start) + value + text.slice(end), start: caret, end: caret };
  };
  if (lineCommentMarker(path) === '//' || blockCommentMarkers(path)?.[0] === '/*') {
    const trimmed = line.trimStart();
    if (/^\/\*\*?(?!.*\*\/)/.test(trimmed)) return insert(`\n${indent} * `);
    if (/^\*(?!\/)/.test(trimmed) && !trimmed.includes('*/')) return insert(`\n${indent}* `);
  }
  if (COLON_BLOCKS.has(extension)) {
    if (line.trimEnd().endsWith(':') && !line.trimStart().startsWith('#'))
      return insert(`\n${indent}${unit}`);
    if (extension.startsWith('py') && PY_EXIT.test(line) && indent)
      return insert(
        `\n${indent.slice(0, Math.max(0, indent.length - (unit === '\t' ? 1 : unit.length)))}`,
      );
  }
  return null;
}

/**
 * Every code-editor keystroke with an edit of its own, or null to let the textarea take it.
 * Text-only results (same text, new selection) only move the caret or selection.
 */
export function codeEditorEdit(event: EditorKey, text: string, path: string): TextEdit | null {
  if (event.nativeEvent?.isComposing) return null;
  const { selectionStart: start, selectionEnd: end } = event.currentTarget;
  const command = event.ctrlKey || event.metaKey;
  if (command && !event.altKey) {
    if (event.key === '/') {
      const marker = lineCommentMarker(path);
      if (marker) return toggleLineComment(text, start, end, marker);
      const block = blockCommentMarkers(path);
      return block ? toggleBlockComment(text, start, end, block) : null;
    }
    if (event.shiftKey && event.key.toLowerCase() === 'k') return deleteLines(text, start, end);
    if (event.key === ']') return indentLines(text, start, end, indentUnit(text));
    if (event.key === '[') return outdentLines(text, start, end, indentUnit(text));
    return null;
  }
  if (event.key === 'Home' && !command && !event.altKey && !event.shiftKey && start === end) {
    const caret = smartHome(text, start);
    return { text, start: caret, end: caret };
  }
  if (event.key === 'Enter' && !event.shiftKey && !command && !event.altKey) {
    const language = languageNewline(text, start, end, path);
    if (language) return language;
    // Between a bracket pair, the generic rule already places the closer.
    return newlineWithIndent(text, start, end, indentUnit(text));
  }
  return editorPairEdit(event, text, path) ?? editorKeyEdit(event, text);
}
