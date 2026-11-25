import { stripVTControlCharacters } from 'node:util';
import type { DOMElement } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { displayWidth, truncateDisplay } from './terminal-width.js';

export interface CellPoint {
  row: number;
  col: number;
}
export interface CellRange {
  anchor: CellPoint;
  head: CellPoint;
}
export interface TextRun {
  row: number;
  col: number;
  text: string;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function orderedRange(range: CellRange): [CellPoint, CellPoint] {
  const { anchor: a, head: b } = range;
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}

function isFiniteRange(range: CellRange): boolean {
  return (
    Number.isFinite(range.anchor.row) &&
    Number.isFinite(range.anchor.col) &&
    Number.isFinite(range.head.row) &&
    Number.isFinite(range.head.col)
  );
}

/** Display cells, never UTF-16 offsets; touching either half selects a whole grapheme. */
export function selectedRuns(runs: readonly TextRun[], range: CellRange): TextRun[] {
  if (!isFiniteRange(range)) return [];
  const [start, end] = orderedRange(range);
  return runs.flatMap((run) => {
    if (run.row < start.row || run.row > end.row) return [];
    const left = run.row === start.row ? start.col : 0;
    const right = run.row === end.row ? end.col : Infinity;
    let col = run.col;
    let first = -1;
    let text = '';
    for (const { segment } of graphemes.segment(run.text)) {
      const width = displayWidth(segment);
      if (col <= right && col + width > left) {
        if (first < 0) first = col;
        text += segment;
      }
      col += width;
    }
    return first < 0 ? [] : [{ row: run.row, col: first, text }];
  });
}

export function selectionText(runs: readonly TextRun[], range: CellRange): string {
  if (!isFiniteRange(range)) return '';
  const selected = selectedRuns(runs, range);
  const rows = new Map<number, TextRun[]>();
  for (const run of selected) rows.set(run.row, [...(rows.get(run.row) ?? []), run]);
  const lines: string[] = [];
  const [start, end] = orderedRange(range);
  for (let row = start.row; row <= end.row; row++) {
    let line = '';
    const rowRuns = (rows.get(row) ?? []).sort((a, b) => a.col - b.col);
    // Padding before the first text node belongs to layout chrome, not text.
    let col = rowRuns[0]?.col ?? 0;
    for (const run of rowRuns) {
      line += ' '.repeat(Math.max(0, run.col - col)) + run.text;
      col = run.col + displayWidth(run.text);
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n').trimEnd();
}

function flatten(node: DOMElement): string {
  let text = node.childNodes
    .map((child) => (child.nodeName === '#text' ? child.nodeValue : flatten(child)))
    .join('');
  if (node.internal_transform) text = node.internal_transform(text, 0);
  return stripVTControlCharacters(text);
}

/** Read mounted text using Ink's Yoga geometry. Box borders are deliberately not text. */
export function mountedTextRuns(root: DOMElement): TextRun[] {
  const runs: TextRun[] = [];
  const width = root.yogaNode?.getComputedWidth() ?? 0;
  const height = root.yogaNode?.getComputedHeight() ?? 0;
  function visit(
    node: DOMElement,
    px: number,
    py: number,
    clip: { x: number; y: number; right: number; bottom: number },
    isRoot = false,
  ): void {
    if (clip.x >= clip.right || clip.y >= clip.bottom) return;
    const yoga = node.yogaNode;
    if (!yoga || yoga.getDisplay() === 1) return;
    const x = px + (isRoot ? 0 : yoga.getComputedLeft());
    const y = py + (isRoot ? 0 : yoga.getComputedTop());
    if (node.nodeName === 'ink-text') {
      const w = Math.max(
        1,
        yoga.getComputedWidth() - yoga.getComputedPadding(0) - yoga.getComputedPadding(2),
      );
      const text = flatten(node);
      const wrapped = node.style.textWrap?.startsWith('truncate')
        ? text
            .split('\n')
            .map((line) => truncateDisplay(line, w))
            .join('\n')
        : wrapAnsi(text, w, { hard: true, trim: false });
      const textNode = node.childNodes[0]?.yogaNode;
      const tx = x + (textNode?.getComputedLeft() ?? 0);
      const ty = y + (textNode?.getComputedTop() ?? 0);
      wrapped.split('\n').forEach((line, index) => {
        const row = Math.round(ty + index);
        if (row < clip.y || row >= clip.bottom) return;
        const clipped = selectedRuns([{ row, col: Math.round(tx), text: line }], {
          anchor: { row, col: clip.x },
          head: { row, col: clip.right - 1 },
        });
        runs.push(...clipped);
      });
      return;
    }
    const horizontal = node.style.overflow === 'hidden' || node.style.overflowX === 'hidden';
    const vertical = node.style.overflow === 'hidden' || node.style.overflowY === 'hidden';
    const next = {
      x: horizontal ? Math.max(clip.x, x) : clip.x,
      right: horizontal ? Math.min(clip.right, x + yoga.getComputedWidth()) : clip.right,
      y: vertical ? Math.max(clip.y, y) : clip.y,
      bottom: vertical ? Math.min(clip.bottom, y + yoga.getComputedHeight()) : clip.bottom,
    };
    for (const child of node.childNodes) if (child.nodeName !== '#text') visit(child, x, y, next);
  }
  visit(root, 0, 0, { x: 0, y: 0, right: width, bottom: height }, true);
  return runs;
}

export function screenOrigin(node: DOMElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: DOMElement | undefined = node;
  while (current) {
    x += current.yogaNode?.getComputedLeft() ?? 0;
    y += current.yogaNode?.getComputedTop() ?? 0;
    current = current.parentNode;
  }
  return { x, y };
}
