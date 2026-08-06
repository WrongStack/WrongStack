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
} {
  const { stdoutRows, viewportRows, setViewportRows } = input;
  const bottomRegionRef = useRef<DOMElement | null>(null);
  const statusBarWrapRef = useRef<DOMElement | null>(null);
  const belowStatusBarRef = useRef<DOMElement | null>(null);
  const [termRows, setTermRows] = useState(stdoutRows ?? 24);

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

  return { bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows };
}
