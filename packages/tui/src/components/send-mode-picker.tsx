import { Box, Text, useInput } from '../ink.js';
import type React from 'react';

/**
 * How a plain message typed mid-run should be delivered to the agent.
 * Mirrors the WebUI's `QueueMode` vocabulary (ChatInput.tsx).
 */
export type SendMode = 'queue' | 'btw' | 'steer';

interface SendModeOption {
  mode: SendMode;
  /** Quick-select key (lower-case). */
  key: string;
  label: string;
  description: string;
  color: string;
}

/**
 * The three delivery modes, Queue first so it is the default highlight and
 * the safest no-op-to-in-flight-work choice. Order is load-bearing: the
 * reducer indexes selection into this array.
 */
export const SEND_MODE_OPTIONS: SendModeOption[] = [
  {
    mode: 'queue',
    key: 'q',
    label: 'Queue',
    description: 'Run after the current turn finishes (default)',
    color: 'green',
  },
  {
    mode: 'btw',
    key: 'b',
    label: 'By the way',
    description: 'Fold in at the next step — no restart, no interrupt',
    color: 'cyan',
  },
  {
    mode: 'steer',
    key: 's',
    label: 'Steer',
    description: 'Abort now, drop the queue, redirect to this',
    color: 'red',
  },
];

/**
 * Clamp-free wrap-around index move. `delta` is +1 (down) / -1 (up).
 * Pure — unit-tested independently of Ink.
 */
export function nextSendModeIndex(selected: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  return (((selected + delta) % len) + len) % len;
}

/** A minimal structural view of the key event — keeps the helper pure/testable. */
export interface SendModeKey {
  upArrow?: boolean | undefined;
  downArrow?: boolean | undefined;
  return?: boolean | undefined;
  escape?: boolean | undefined;
}

/**
 * Map a keypress to a picker decision. Returns:
 *   - a `SendMode` when the user committed a choice (quick-key or Enter),
 *   - `'cancel'` on Esc,
 *   - `null` when the key only moves the selection / is irrelevant
 *     (the caller handles `↑/↓` movement separately).
 *
 * Pure: no Ink, no React. The single source of truth for key semantics.
 */
export function sendModeFromKey(
  input: string,
  key: SendModeKey,
  selected: number,
): SendMode | 'cancel' | null {
  if (key.escape) return 'cancel';
  if (key.return) return SEND_MODE_OPTIONS[selected]?.mode ?? 'queue';
  const ch = input.trim().toLowerCase();
  const match = SEND_MODE_OPTIONS.find((o) => o.key === ch);
  if (match) return match.mode;
  return null;
}

export function formatSendModeMessagePreview(text: string, maxChars = 120): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

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
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginY={1}>
      <Text color="cyan" bold>
        ━━ Deliver this message how? ━━
      </Text>
      {messagePreview ? (
        <Text>
          <Text dimColor>Message: </Text>
          <Text color="white">{formatSendModeMessagePreview(messagePreview)}</Text>
        </Text>
      ) : null}
      <Text dimColor>q/b/s pick · ↑/↓ move · Enter select · Esc → back to input</Text>
      {SEND_MODE_OPTIONS.map((opt, i) => (
        <Text
          key={opt.mode}
          inverse={i === selected}
          {...(i === selected ? { color: opt.color } : {})}
        >
          {i === selected ? '› ' : '  '}
          <Text bold color={opt.color}>
            [{opt.key}]
          </Text>{' '}
          <Text bold>{opt.label.padEnd(12)}</Text>
          <Text dimColor>{opt.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
