import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text, useInput } from '../ink.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';

import {
  formatSendModeMessagePreview,
  SEND_MODE_OPTIONS,
  type SendMode,
  sendModeFromKey,
} from './send-mode-model.js';

export * from './send-mode-model.js';

interface SendModePickerProps {
  selected: number;
  /** The message being routed, shown so the modal question has context. */
  messagePreview?: string | undefined;
  /** Move the highlight by `delta` (caller clamps/wraps via nextSendModeIndex). */
  onMove: (delta: number) => void;
  /** Commit a decision (quick-key / Enter) or cancel (Esc → 'cancel'). */
  onSelect: (decision: SendMode | 'cancel') => void;
}

/**
 * Modal shown when the user submits a plain message while the agent is busy.
 * Self-contained input handling (own `useInput`) like {@link EscConfirmPrompt};
 * the main input is gated off via a handleKey early-return while this is open.
 *
 * - q / b / s → pick that mode immediately
 * - ↑ / ↓     → move the highlight
 * - Enter     → pick the highlighted mode
 * - Esc       → cancel (caller restores the draft to the composer)
 */
export function SendModePicker({
  selected,
  messagePreview,
  onMove,
  onSelect,
}: SendModePickerProps): React.ReactElement {
  const size = useTerminalSize();
  // The border and one column of padding consume four of the allocated
  // columns. Every row must fit the remainder: a wrapped row steals one of
  // the eight rows the capped bottom region has at 40x8.
  const innerWidth = Math.max(1, size.columns - 4);
  const fullHint = 'q/b/s pick · ↑/↓ move · Enter select · Esc → back to input';
  const escapeHint = 'Esc → back to input';
  const hint = displayWidth(fullHint) <= innerWidth ? fullHint : escapeHint;
  const preview = messagePreview
    ? truncateDisplay(
        formatSendModeMessagePreview(messagePreview),
        Math.max(0, innerWidth - displayWidth('Message: ')),
      )
    : undefined;

  useInput((input, key) => {
    if (key.upArrow) {
      onMove(-1);
      return;
    }
    if (key.downArrow) {
      onMove(1);
      return;
    }
    const decision = sendModeFromKey(input, key, selected);
    if (decision) onSelect(decision);
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginY={size.rows >= 10 ? 1 : 0}
    >
      <Text color="cyan" bold>
        {truncateDisplay('━━ Deliver this message how? ━━', innerWidth)}
      </Text>
      {preview ? (
        <Text>
          <Text dimColor>Message: </Text>
          <Text color="white">{preview}</Text>
        </Text>
      ) : null}
      <Text dimColor>{hint}</Text>
      {SEND_MODE_OPTIONS.map((opt, i) => {
        const marker = i === selected ? '› ' : '  ';
        const label = opt.label.padEnd(12);
        const prefix = `${marker}[${opt.key}] ${label}`;
        const description = truncateDisplay(
          opt.description,
          Math.max(0, innerWidth - displayWidth(prefix)),
        );
        return (
          <Text
            key={opt.mode}
            inverse={i === selected}
            {...(i === selected ? { color: opt.color } : {})}
          >
            {marker}
            <Text bold color={opt.color}>
              [{opt.key}]
            </Text>{' '}
            <Text bold>{label}</Text>
            <Text dimColor>{description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
