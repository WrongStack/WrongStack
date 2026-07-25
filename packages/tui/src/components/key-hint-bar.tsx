import { Box, Text } from '../ink.js';
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
  // Idle / chat — brand line instead of keybinding hints.
  return [{ key: '', label: 'github.com/wrongstack/wrongstack' }];
}

/**
 * Persistent one-line keybinding hint bar shown at the very bottom of the TUI,
 * like a status-line cheat sheet. Context-aware: surfaces the keys that matter
 * for whatever is on screen (confirm prompt → y/n/a/d, picker → ↑↓/↵, etc.).
 * Discovery hints (next panel) are rendered in a distinct color to encourage exploration.
 */
export function KeyHintBar({ context }: { context: KeyHintContext }): React.ReactElement {
  const hints = hintsFor(context);
  return (
    <Box flexDirection="row" paddingX={1}>
      {hints.map((h, i) => (
        <Box key={i} flexDirection="row" marginRight={2}>
          <Text color={h.discovery ? theme.monitor.agents : theme.accent}>{h.key}</Text>
          <Text dimColor>{` ${h.label}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
