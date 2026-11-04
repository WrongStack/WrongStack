import { type ComposerFileReference, MAX_SNIPPET_CHARS } from './composer-resources-model';
import { selectionLineRange, sourcePointOffset } from './file-model';

interface ViewedDocument {
  content: string;
  saved: string;
  editing?: boolean;
}

/** Character offset of a DOM selection point inside the rendered source lines. */
function viewerOffset(root: HTMLElement, content: string, node: Node, offset: number) {
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest('[data-source-line]');
  if (!row || !root.contains(row)) return null;
  const line = Number(row.getAttribute('data-source-line'));
  const code = row.querySelector('code');
  let column = 0;
  if (code?.contains(node)) {
    const range = document.createRange();
    range.setStart(code, 0);
    range.setEnd(node, offset);
    column = range.toString().length;
  } else if (code && row === node && offset > [...row.childNodes].indexOf(code)) {
    column = Number.MAX_SAFE_INTEGER; // After the code element: the end of the line.
  }
  return sourcePointOffset(content, line, column);
}

/** Start and end offsets of the current selection in the editor or the read-only viewer. */
function selectionOffsets(root: HTMLElement, doc: ViewedDocument): [number, number] | null {
  const editor = root.querySelector<HTMLTextAreaElement>('textarea.file-code-editor');
  if (doc.editing && editor) return [editor.selectionStart, editor.selectionEnd];
  // The code editor keeps its selection on its holder as start and end offsets.
  const code = root.querySelector<HTMLElement>('[data-editor-selection]');
  if (doc.editing && code) {
    const [start = 0, end = 0] = (code.dataset['editorSelection'] ?? '').split(':').map(Number);
    return [Math.min(start, end), Math.max(start, end)];
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode)
    return null;
  const a = viewerOffset(root, doc.content, selection.anchorNode, selection.anchorOffset);
  const b = viewerOffset(root, doc.content, selection.focusNode, selection.focusOffset);
  return a === null || b === null ? null : [Math.min(a, b), Math.max(a, b)];
}

/**
 * Builds the conversation reference for the open file. Line ranges point at the file on disk,
 * so they are refused over unsaved text; a quote carries the selected text itself and only
 * adds line numbers when they still match the disk version.
 */
export function selectionReference(
  path: string,
  doc: ViewedDocument,
  root: HTMLElement,
  quote: boolean,
): { reference: ComposerFileReference } | { error: string } {
  const offsets = selectionOffsets(root, doc);
  const lines = offsets ? selectionLineRange(doc.content, offsets[0], offsets[1]) : null;
  const unsaved = doc.content !== doc.saved;
  if (!quote) {
    if (lines && unsaved)
      return {
        error:
          'Save this file before referencing selected lines; the conversation reads it from disk.',
      };
    return { reference: lines ? { path, lines } : { path } };
  }
  const snippet = offsets ? doc.content.slice(offsets[0], offsets[1]) : '';
  if (!snippet.trim()) return { error: 'Select the text to quote first.' };
  if (snippet.length > MAX_SNIPPET_CHARS)
    return {
      error: `The selection has ${snippet.length.toLocaleString()} characters; quotes are limited to ${MAX_SNIPPET_CHARS.toLocaleString()}. Reference the lines instead.`,
    };
  return { reference: { path, ...(lines && !unsaved ? { lines } : {}), snippet } };
}
