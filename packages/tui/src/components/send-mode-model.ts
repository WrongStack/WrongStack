// Pure send-mode vocabulary and key semantics (no Ink/React), shared by the
// picker view and the dialogs reducer.

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
  if (!Number.isFinite(len) || len <= 0) return 0;
  const safeSelected = Number.isFinite(selected) ? Math.trunc(selected) : 0;
  const safeDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const safeLen = Math.floor(len);
  if (safeLen <= 0) return 0;
  return (((safeSelected + safeDelta) % safeLen) + safeLen) % safeLen;
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
  const safeMax = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 120;
  if (safeMax === 0) return '';
  if (singleLine.length <= safeMax) return singleLine;
  let end = Math.max(0, safeMax - 1);
  if (end > 0) {
    const last = singleLine.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return `${singleLine.slice(0, end)}…`;
}
