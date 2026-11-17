import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { historyViewportRows } from '../hit-test.js';
import { type DOMElement, measureElement, useStdout } from '../ink.js';
import { terminalDimension } from '../terminal-dimensions.js';

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
   * Measured height of the status bar itself. The shared picker/monitor
   * viewport reserves this chrome before sizing its content. Including the
   * monitors here would subtract their own height from their next viewport,
   * causing repeated expand/shrink updates when a function-key panel opens.
   */
  statusBarRows: number;
} {
  const { stdoutRows, viewportRows, setViewportRows } = input;
  const { stdout } = useStdout();
  const stream = stdout ?? process.stdout;
  const bottomRegionRef = useRef<DOMElement | null>(null);
  const statusBarWrapRef = useRef<DOMElement | null>(null);
  const belowStatusBarRef = useRef<DOMElement | null>(null);
  const [termRows, setTermRows] = useState(() =>
    terminalDimension(stream.rows, terminalDimension(stdoutRows, 24)),
  );
  const [statusBarRows, setStatusBarRows] = useState(2);

  useEffect(() => {
    // Deliberately NOT `useTerminalSize`. This one uses `prependListener`: the
    // viewport measurement has to see the new row count before the panels that
    // lay out inside it react, and the shared hook subscribes with `on`.
    // Ordering is the reason this copy exists.
    const handleResize = () => setTermRows(terminalDimension(stream.rows, 24));
    stream.prependListener('resize', handleResize);
    // A resize can happen between the first frame and this subscription.
    // Re-read after subscribing so the root never retains an outdated height.
    handleResize();
    return () => {
      stream.off('resize', handleResize);
    };
  }, [stream]);

  useLayoutEffect(() => {
    const node = bottomRegionRef.current;
    if (!node) return;
    const rows = historyViewportRows(termRows, measureElement(node).height);
    if (rows !== viewportRows) {
      setViewportRows(rows);
    }
  });

  // Reserve only independent chrome. Panels below the bar consume the shared
  // monitor viewport; measuring them here would feed their height back into
  // their own size budget. bottomRegionRef still includes all panels when
  // measuring the space left for history, and belowStatusBarRef remains
  // available for status-bar pointer hit testing.
  useLayoutEffect(() => {
    const bar = statusBarWrapRef.current;
    if (!bar) return;
    const height = measureElement(bar).height;
    const rows = Math.max(1, Math.ceil(height));
    setStatusBarRows((prev) => (prev === rows ? prev : rows));
  });

  return { bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows, statusBarRows };
}
