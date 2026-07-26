import { Box, Text } from '../ink.js';
import { useEffect, useState } from 'react';
import type React from 'react';
import { theme } from '../theme.js';

/** Which interactive context is active — drives which shortcuts the bar shows.
 *  Ordered by priority (a confirm prompt overrides a picker, etc.). */
export interface KeyHintContext {
  confirm?: boolean | undefined;
  picker?: boolean | undefined; // file / slash / model / autonomy picker, or rewind overlay
  monitor?: boolean; // any full-screen monitor overlay open
  managed?: boolean; // managed viewport active (in-app scroll)
  /** Hint for the next panel: key combination and panel name to encourage discovery. */
  nextPanelHint?: { key: string; label: string } | undefined;
}

export interface Hint {
  key: string;
  label: string;
  /** When true, render in a distinct color to highlight panel discovery. */
  discovery?: boolean | undefined;
}

/**
 * Messages cycled in the idle status line (no active confirm/picker/monitor).
 * The first entry is the canonical brand link — tests depend on it being
 * index 0, so keep it there.
 */
export const IDLE_MESSAGES: readonly Hint[] = [
  { key: '', label: 'github.com/wrongstack/wrongstack' },
  { key: '', label: '★ star us on GitHub!' },
  { key: '', label: 'visit wrongstack.com' },
  { key: '', label: 'press ? for help' },
  { key: '', label: 'Ctrl+B toggles the sidebar' },
] as const;

/** Returns true when no interactive context is active (idle / chat). */
export function isIdleContext(ctx: KeyHintContext): boolean {
  return !ctx.confirm && !ctx.picker && !ctx.monitor && !ctx.managed;
}

export function hintsFor(ctx: KeyHintContext): Hint[] {
  if (ctx.confirm) {
    return [
      { key: 'y', label: 'yes' },
      { key: 'n', label: 'no' },
      { key: 'a', label: 'always' },
      { key: 'd', label: 'deny' },
    ];
  }
  if (ctx.picker) {
    return [
      { key: '↑↓', label: 'move' },
      { key: '↵', label: 'select' },
      { key: 'Esc', label: 'cancel' },
    ];
  }
  if (ctx.monitor) {
    const hints: Hint[] = [
      { key: 'Esc', label: 'close' },
      { key: 'F2', label: 'fleet' },
      { key: 'F3', label: 'agents' },
      { key: 'F4', label: 'worktrees' },
      { key: 'F6', label: 'todos' },
      { key: 'F9', label: 'goal' },
    ];
    if (ctx.nextPanelHint) {
      hints.push({ key: ctx.nextPanelHint.key, label: ctx.nextPanelHint.label, discovery: true });
    }
    return hints;
  }
  if (ctx.managed) {
    return [
      { key: 'wheel', label: 'scroll' },
      { key: 'Ctrl+U/D', label: 'page' },
    ];
  }
  // Idle / chat — first entry of the rotating message set.
  return [IDLE_MESSAGES[0]!];
}

/**
 * Persistent one-line keybinding hint bar shown at the very bottom of the TUI,
 * like a status-line cheat sheet. Context-aware: surfaces the keys that matter
 * for whatever is on screen (confirm prompt → y/n/a/d, picker → ↑↓/↵, etc.).
 * Discovery hints (next panel) are rendered in a distinct color to encourage exploration.
 *
 * When idle (no active context), the bar rotates through {@link IDLE_MESSAGES}
 * on an interval so the status line serves different purposes over time.
 */
export function KeyHintBar({ context }: { context: KeyHintContext }): React.ReactElement {
  const hints = hintsFor(context);
  const idle = isIdleContext(context);
  const [idleIndex, setIdleIndex] = useState(0);

  useEffect(() => {
    if (!idle) return; // no rotation while interactive context is active
    const id = setInterval(() => {
      setIdleIndex((prev) => (prev + 1) % IDLE_MESSAGES.length);
    }, 10_000);
    return () => clearInterval(id);
  }, [idle]);

  const displayHints = idle ? [IDLE_MESSAGES[idleIndex]!] : hints;

  return (
    <Box flexDirection="row" paddingX={1}>
      {displayHints.map((h, i) => (
        <Box key={i} flexDirection="row" marginRight={2}>
          <Text color={h.discovery ? theme.monitor.agents : theme.accent}>{h.key}</Text>
          <Text dimColor>{` ${h.label}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
