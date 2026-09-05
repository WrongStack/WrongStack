import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { historyViewportRows } from '../hit-test.js';
import { type DOMElement, measureElement } from '../ink.js';

export function useHistoryViewportSync(input: {
  stdoutRows: number | undefined;
  viewportRows: number;
  setViewportRows(rows: number): void;
}): {
  bottomRegionRef: RefObject<DOMElement | null>;
  statusBarWrapRef: RefObject<DOMElement | null>;
  belowStatusBarRef: RefObject<DOMElement | null>;
  termRows: number;
  /**
   * Measured height (rows) of the status chrome below the pickers: the
   * status bar itself plus everything beneath it (mailbox panel, monitors).
   * Pickers use it to size their window against the REAL
   * space left after input + status chrome instead of the hardcoded
   * 6-row `shellReservedRows` guess in use-windowed-picker.ts — the guess
   * under-reserves whenever the input wraps or the status bar grows, which
   * is exactly the "theme menu doesn't fit" overflow.
   */
  statusBarRows: number;
} {
  const { stdoutRows, viewportRows, setViewportRows } = input;
  const bottomRegionRef = useRef<DOMElement | null>(null);
  const statusBarWrapRef = useRef<DOMElement | null>(null);
  const belowStatusBarRef = useRef<DOMElement | null>(null);
  const [termRows, setTermRows] = useState(stdoutRows ?? 24);
  const [statusBarRows, setStatusBarRows] = useState(2);

  useEffect(() => {
    // Deliberately NOT `useTerminalSize`. This one uses `prependListener`: the
    // viewport measurement has to see the new row count before the panels that
    // lay out inside it react, and the shared hook subscribes with `on`.
    // Ordering is the reason this copy exists.
    const handleResize = () => setTermRows(process.stdout.rows ?? 24);
    process.stdout.prependListener('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  useLayoutEffect(() => {
    const node = bottomRegionRef.current;
    if (!node) return;
    const rows = historyViewportRows(termRows, measureElement(node).height);
    if (rows !== viewportRows) {
      setViewportRows(rows);
    }
  });

  // Measure the status chrome the pickers sit above. The status bar box and
  // everything below it (mailbox panel, monitors) are separate
  // siblings, so both refs must be measured and summed.
  useLayoutEffect(() => {
    const bar = statusBarWrapRef.current;
    const below = belowStatusBarRef.current;
    if (!bar && !below) return;
    const height =
      (bar ? measureElement(bar).height : 0) + (below ? measureElement(below).height : 0);
    const rows = Math.max(1, Math.ceil(height));
    setStatusBarRows((prev) => (prev === rows ? prev : rows));
  });

  return { bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows, statusBarRows };
}
