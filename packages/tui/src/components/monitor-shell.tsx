import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, type DOMElement, measureElement, Text, useInput, useStdin } from '../ink.js';
import { parseMouseEvents, splitTrailingMousePartial } from '../mouse.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { theme } from '../theme.js';

/**
 * Whether panel letter/chord shortcuts (q close, r refresh, d delete, …) may
 * fire. Bottom F-key panels own the keyboard even with a saved chat draft.
 * Other surfaces retain the empty-draft gate because Ink broadcasts input
 * to every mounted handler. The central router protects the hidden composer.
 */
const PanelShortcutsContext = createContext(true);
const PanelInputContext = createContext(true);
export const PanelInputProvider = PanelInputContext.Provider;

/** A foreground prompt temporarily owns all keyboard input over a monitor. */
export function usePanelInput(handler: Parameters<typeof useInput>[0]): void {
  const isActive = useContext(PanelInputContext);
  useInput(handler, { isActive });
}
const MonitorViewportContext = createContext<{
  columns: number;
  rows: number;
  functionKey?: number | null;
} | null>(null);
export const MonitorViewportProvider = MonitorViewportContext.Provider;

export const PanelShortcutsProvider = PanelShortcutsContext.Provider;

/** True when this surface may handle panel letter shortcuts. */
export function usePanelShortcutsEnabled(): boolean {
  return useContext(PanelShortcutsContext);
}

interface MonitorSize {
  columns: number;
  rows: number;
  /** Width inside a full-width round border with one column of horizontal padding. */
  contentWidth: number;
  /** Conservative row budget after the shared header/footer chrome. */
  contentRows: number;
}

export function useMonitorSize(): MonitorSize {
  const size = useTerminalSize({ fallbackColumns: 90 });
  const viewport = useContext(MonitorViewportContext) ?? size;

  return {
    ...viewport,
    contentWidth: Math.max(1, viewport.columns - 4),
    contentRows: Math.max(1, viewport.rows - 9),
  };
}

export function truncatePanelText(text: string, width: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return truncateDisplay(normalized, width);
}

export function panelWindow(
  total: number,
  selected: number,
  limit: number,
): { start: number; end: number; above: number; below: number } {
  if (total <= 0 || limit <= 0) return { start: 0, end: 0, above: 0, below: 0 };
  const safeLimit = Math.max(1, Math.min(total, limit));
  const safeSelected = Math.max(0, Math.min(total - 1, selected));
  const half = Math.floor(safeLimit / 2);
  let start = Math.max(0, safeSelected - half);
  const end = Math.min(total, start + safeLimit);
  start = Math.max(0, end - safeLimit);
  return { start, end, above: start, below: total - end };
}

interface MonitorShellProps {
  accent: string;
  icon: string;
  title: string;
  /**
   * Quiet context beside the title. Shown only when title, kicker and the
   * right-hand content all fit on the header row; callers pass it
   * unconditionally.
   */
  kicker?: string | undefined;
  right?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  children?: ReactNode | undefined;
  grow?: boolean | undefined;
  /** Clamp the shell's total height (including borders) to prevent overflow. */
  maxHeight?: number | undefined;
  /** Pickers already own wheel navigation; disable shell wheel scrolling there. */
  wheelScroll?: boolean | undefined;
}

/** Shared chrome for F-key monitors: one visual hierarchy and one geometry contract. */
export function MonitorShell({
  accent,
  icon,
  title,
  kicker,
  right,
  footer,
  children,
  grow = false,
  maxHeight,
  wheelScroll = true,
}: MonitorShellProps) {
  const size = useMonitorSize();
  const viewport = useContext(MonitorViewportContext);
  const inputActive = useContext(PanelInputContext);
  const bodyRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const [scroll, setScroll] = useState(0);
  const [maxScroll, setMaxScroll] = useState(0);
  const headerRef = useRef<DOMElement>(null);
  const rightRef = useRef<DOMElement>(null);
  const [headerFit, setHeaderFit] = useState<{ header: number; right: number } | null>(null);
  const { stdin } = useStdin();
  const showRight = size.columns >= 64 && right != null;
  const compactClose = size.rows < 8 ? viewport?.functionKey : null;
  const panelFooter = compactClose ? (
    <Text color={theme.textMuted} wrap="truncate-end">{`F${compactClose}/Esc close`}</Text>
  ) : (
    footer
  );
  // The kicker is shown only when it fits beside the title and the right-hand
  // content. Both widths are measured after layout: the header row gives the
  // real width available (a viewport-less mount can differ from the terminal
  // size), and the right-hand box never shrinks, so its width does not depend
  // on the kicker decision and cannot feed back into it. A passive effect —
  // a layout-phase state update here held back Ink's resize repaint.
  useEffect(() => {
    const header = headerRef.current ? measureElement(headerRef.current).width : 0;
    const rightWidth = showRight && rightRef.current ? measureElement(rightRef.current).width : 0;
    setHeaderFit((prev) =>
      prev && prev.header === header && prev.right === rightWidth
        ? prev
        : { header, right: rightWidth },
    );
  });
  const available = headerFit?.header || size.contentWidth;
  const kickerFits =
    kicker !== undefined &&
    kicker !== '' &&
    displayWidth(`${icon} ${title} / ${kicker}`) + (showRight ? (headerFit?.right ?? 0) + 1 : 0) <=
      available;
  useLayoutEffect(() => {
    if (!viewport || !bodyRef.current || !contentRef.current) return;
    const maximum = Math.max(
      0,
      measureElement(contentRef.current).height - measureElement(bodyRef.current).height,
    );
    setMaxScroll((value) => (value === maximum ? value : maximum));
    setScroll((value) => Math.min(value, maximum));
  });
  useInput(
    (_input, key) => {
      if (key.meta && (key.pageUp || key.pageDown)) {
        setScroll((value) => Math.max(0, Math.min(maxScroll, value + (key.pageUp ? -1 : 1) * 3)));
      } else if (key.upArrow || key.downArrow || key.tab) {
        setScroll(0);
      }
    },
    { isActive: viewport !== null && inputActive },
  );
  useEffect(() => {
    if (!inputActive || !viewport || !wheelScroll || !stdin || maxScroll === 0) return;
    let partial = '';
    const onData = (data: Buffer | string) => {
      const chunk = splitTrailingMousePartial(partial + data.toString());
      partial = chunk.pending;
      if (!bodyRef.current) return;
      const rect = measureElement(bodyRef.current);
      for (const event of parseMouseEvents(chunk.consumed)) {
        if (
          event.kind !== 'wheel' ||
          event.x <= rect.x ||
          event.x > rect.x + rect.width ||
          event.y <= rect.y ||
          event.y > rect.y + rect.height
        )
          continue;
        setScroll((value) => Math.max(0, Math.min(maxScroll, value - event.wheel * 3)));
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, viewport, wheelScroll, maxScroll, inputActive]);
  return (
    <Box
      alignSelf="stretch"
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      flexGrow={grow ? 1 : 0}
      maxHeight={viewport ? Math.min(maxHeight ?? viewport.rows, viewport.rows) : maxHeight}
      overflow={viewport ? 'hidden' : undefined}
    >
      <Box ref={headerRef} height={1} flexShrink={0} overflow="hidden">
        {/* While a kicker is shown it yields first: until a resize is
            re-measured it truncates, never the title. */}
        <Box flexShrink={kickerFits ? 0 : 1}>
          <Text color={accent} bold wrap="truncate-end">
            {icon} {title}
          </Text>
        </Box>
        {kickerFits ? (
          <Box flexShrink={1}>
            <Text color={theme.textMuted} wrap="truncate-end">
              {' '}
              / {kicker}
            </Text>
          </Box>
        ) : null}
        <Box flexGrow={1} />
        {showRight ? (
          <Box ref={rightRef} flexShrink={0}>
            {right}
          </Box>
        ) : null}
      </Box>
      {viewport ? (
        <Box ref={bodyRef} flexDirection="column" flexShrink={1} overflow="hidden">
          <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-scroll}>
            {children}
          </Box>
        </Box>
      ) : (
        children
      )}
      {maxScroll > 0 && !compactClose ? (
        <Box flexShrink={0}>
          <Text dimColor>
            Alt+PgUp/Dn scroll {scroll}/{maxScroll}
          </Text>
        </Box>
      ) : null}
      {panelFooter ? (
        <Box marginTop={size.rows >= 16 ? 1 : 0} flexShrink={0}>
          {panelFooter}
        </Box>
      ) : null}
    </Box>
  );
}

export function SectionLabel({
  children,
  color = theme.textMuted,
}: {
  children: ReactNode;
  color?: string | undefined;
}) {
  return (
    <Text color={color} bold>
      {children}
    </Text>
  );
}

export function KeyCap({
  keyName,
  label,
  color = theme.accent,
  keepTogether = false,
}: {
  keyName: string;
  label: string;
  color?: string | undefined;
  keepTogether?: boolean | undefined;
}) {
  const content = (
    <Text>
      <Text
        color={color}
        bold
        {...(theme.supportsBackground ? { backgroundColor: theme.surfaceRaised } : {})}
      >
        {' '}
        {keyName}{' '}
      </Text>
      <Text color={theme.textMuted}> {label}</Text>
    </Text>
  );
  return keepTogether ? <Box flexShrink={0}>{content}</Box> : content;
}

export function EmptyPanelState({
  icon,
  title,
  detail,
  accent = theme.textMuted,
}: {
  icon: string;
  title: string;
  detail?: ReactNode | undefined;
  accent?: string | undefined;
}) {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color={accent} bold>
        {icon} {title}
      </Text>
      {detail ? (
        <Box marginTop={1}>
          <Text color={theme.textMuted}>{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
