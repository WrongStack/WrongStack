import { useEffect, useRef, useState } from 'react';
import { type CellRange, screenOrigin, selectionText, type TextRun } from '../cell-selection.js';
import { clipboardFailureNotice, writeClipboardTextOutcome } from '../clipboard.js';
import type { DOMElement } from '../ink.js';
import type { MouseEventInfo } from '../mouse.js';

export interface ComposerPointerModel {
  node: DOMElement | null;
  runs: TextRun[];
  width: number;
  rows: number;
  hidden: boolean;
  disabled: boolean;
  value: string;
  scroll: number;
  mode: 'block' | 'text';
  toggle?: (() => void) | undefined;
  begin?: (() => void) | undefined;
}

export function useComposerPointer() {
  const model = useRef<ComposerPointerModel | null>(null);
  const active = useRef<{ range: CellRange; runs: TextRun[] } | null>(null);
  const [selection, setSelection] = useState<{ range: CellRange | null; runs: TextRun[] }>({
    range: null,
    runs: [],
  });
  const [notice, setNotice] = useState('');
  const previous = useRef('');
  useEffect(() => {
    const m = model.current;
    const identity = m
      ? JSON.stringify([m.value, m.scroll, m.width, m.hidden, m.disabled, m.mode])
      : '';
    if (identity !== previous.current) {
      previous.current = identity;
      active.current = null;
      setSelection((old) => (old.range ? { range: null, runs: [] } : old));
    }
  });
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 1500);
    return () => clearTimeout(timer);
  }, [notice]);
  function handle(mouse: MouseEventInfo): boolean {
    const m = model.current;
    if (!m?.node || m.hidden || m.disabled) return false;
    const origin = screenOrigin(m.node);
    const point = { col: mouse.x - 1 - origin.x, row: mouse.y - 1 - origin.y };
    const inside =
      point.col >= 2 && point.col < m.width - 2 && point.row >= 1 && point.row <= m.rows;
    if (mouse.kind === 'press' && mouse.button === 'left') {
      active.current = null;
      setSelection({ range: null, runs: [] });
      if (
        point.row === m.rows + 1 &&
        point.col >= 3 &&
        point.col < 10 &&
        m.width >= 14 &&
        m.toggle
      ) {
        m.toggle();
        return true;
      }
      if (!inside) return false;
      m.begin?.();
      const next = { range: { anchor: point, head: point }, runs: m.runs };
      active.current = next;
      setSelection(next);
      return true;
    }
    const current = active.current;
    if (!current) return false;
    if (mouse.kind === 'wheel' || !inside || mouse.button !== 'left') {
      active.current = null;
      setSelection({ range: null, runs: [] });
      return false;
    }
    if (mouse.kind === 'move') {
      const next = { ...current, range: { ...current.range, head: point } };
      active.current = next;
      setSelection(next);
      return true;
    }
    if (mouse.kind === 'release') {
      active.current = null;
      setSelection({ range: null, runs: [] });
      const { anchor } = current.range;
      if (anchor.row === point.row && anchor.col === point.col) return true;
      const text = selectionText(current.runs, { anchor, head: point });
      if (text)
        void Promise.resolve()
          .then(() => writeClipboardTextOutcome(text))
          .then(
            (outcome) => setNotice(outcome.ok ? 'Copied' : clipboardFailureNotice(outcome.reason)),
            () => setNotice('Copy failed'),
          );
      return true;
    }
    return false;
  }
  return { model, handle, selection, notice };
}
