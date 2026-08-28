import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';

/**
 * Whether panel letter/chord shortcuts (q close, r refresh, d delete, …) may
 * fire. Monitors are NON-modal — the composer stays live behind them and
 * Ink's `useInput` is a broadcast — so every keystroke the user types into
 * chat also reaches each open panel's handler. The provider (AppView) sets
 * this to `state.buffer === ''`: with a non-empty draft the user is writing a
 * message, so single-letter panel shortcuts must stay inert. Mirrors the SDD
 * board's empty-draft gate in app-key-handler.ts. Arrow/selection keys are
 * NOT gated — the composer's own arrow handling is already suppressed while
 * an overlay is open, so panels own those outright.
 */
const PanelShortcutsContext = createContext(true);

export const PanelShortcutsProvider = PanelShortcutsContext.Provider;

/** True when panel letter shortcuts may fire (empty composer draft). */
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

  return {
    ...size,
    contentWidth: Math.max(24, size.columns - 4),
    contentRows: Math.max(4, size.rows - 9),
  };
}

export function truncatePanelText(text: string, width: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  if (normalized.length <= width) return normalized;
  if (width === 1) return '…';
  return `${normalized.slice(0, width - 1)}…`;
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
  /** Quiet context beside the title, hidden by callers on narrow terminals. */
  kicker?: string | undefined;
  right?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  children?: ReactNode | undefined;
  grow?: boolean | undefined;
  /** Clamp the shell's total height (including borders) to prevent overflow. */
  maxHeight?: number | undefined;
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
}: MonitorShellProps) {
  return (
    <Box
      alignSelf="stretch"
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      flexGrow={grow ? 1 : 0}
      maxHeight={maxHeight}
    >
      <Box height={1}>
        <Text color={accent} bold>
          {icon} {title}
        </Text>
        {kicker ? <Text color={theme.textMuted}> / {kicker}</Text> : null}
        <Box flexGrow={1} />
        {right}
      </Box>
      {children}
      {footer ? <Box marginTop={1}>{footer}</Box> : null}
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
}: {
  keyName: string;
  label: string;
  color?: string | undefined;
}) {
  return (
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
