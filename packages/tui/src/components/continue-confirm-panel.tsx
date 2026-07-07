import React from 'react';
import { Box, Text, useInput } from '../ink.js';

export type ContinueDecision = 'proceed' | 'edit' | 'cancel';

/**
 * Return the visible auto-proceed countdown in seconds, or null when the user
 * must make an explicit choice. Keeping this as a tiny pure helper gives tests
 * a stable contract without driving Ink timers.
 */
export function continueAutoProceedSeconds(grounded: boolean, delayMs: number): number | null {
  return grounded ? Math.max(1, Math.ceil(delayMs / 1000)) : null;
}

export interface ContinueConfirmPanelProps {
  /** One-line summary of what "continue" resolved to. */
  label: string;
  /** The full instruction that will be sent in place of the bare "continue". */
  instruction: string;
  /** Resolution origin — drives the copy and the drift warning. */
  source: 'todo' | 'suggestion' | 'open';
  /**
   * True for todo/suggestion resolutions (an explicit anchor, low drift): the
   * panel auto-proceeds after `delayMs`. False for the `open` guess: no
   * countdown, an explicit keypress is required.
   */
  grounded: boolean;
  /** Auto-proceed countdown (ms) for grounded resolutions. Ignored when !grounded. */
  delayMs: number;
  /** Called once with the chosen action (keypress or, when grounded, countdown expiry). */
  onDecision: (decision: ContinueDecision) => void;
}

/**
 * Bare-"continue" confirmation ("you said continue — here's what that means").
 *
 * The whole point is to make the resolution *and its drift risk* visible
 * instead of silently guessing:
 *
 *   - **grounded** (todo / suggestion) — a concrete anchor exists, so we show
 *     it and auto-proceed after a short countdown. Enter sends now, Esc cancels,
 *     e loads it into the input to tweak.
 *   - **open** (no queued task) — "continue" is genuinely ambiguous here, so we
 *     do NOT auto-send. We show a ⚠ drift notice ("no pending task — I'll pick
 *     the next step from context") and wait for the user: Enter to trust the
 *     guess, e to type what to continue, Esc to cancel.
 *
 * Self-contained like EnhancePanel/ConfirmPrompt: owns its keys via `useInput`
 * and (when grounded) its timer via a ref so the countdown never triggers a
 * per-second re-render that would bleed blank rows into inline scrollback.
 * `onDecision` is guarded by the caller so only the first decision wins.
 */
export function ContinueConfirmPanel({
  label,
  instruction,
  source,
  grounded,
  delayMs,
  onDecision,
}: ContinueConfirmPanelProps): React.ReactElement {
  const autoProceedSecs = continueAutoProceedSeconds(grounded, delayMs);
  const remainingRef = React.useRef(autoProceedSecs ?? 0);
  const decideRef = React.useRef(onDecision);
  decideRef.current = onDecision;

  // Grounded resolutions auto-proceed. The countdown runs off a ref (no state)
  // so it never re-renders the panel. Open resolutions get no timer — the user
  // must act, because we are guessing.
  React.useEffect(() => {
    if (!grounded) return;
    const id = setInterval(() => {
      const r = remainingRef.current - 1;
      remainingRef.current = r;
      if (r <= 0) {
        clearInterval(id);
        decideRef.current('proceed');
      }
    }, 1000);
    return () => clearInterval(id);
  }, [grounded]);

  useInput((input, key) => {
    if (key.return) {
      onDecision('proceed');
    } else if (key.escape) {
      onDecision('cancel');
    } else if (input?.toLowerCase() === 'e') {
      onDecision('edit');
    }
  });

  const accent = grounded ? 'cyan' : 'yellow';
  // Show the resolved instruction body, trimmed of the trailing procedural
  // sentence so the panel stays compact — the label already names the target.
  const preview = instruction.length > 320 ? `${instruction.slice(0, 317)}…` : instruction;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Box flexDirection="row">
        <Text bold color={accent}>
          {grounded ? '▶ Continue' : '⚠ Continue (ambiguous)'}
        </Text>
        <Text dimColor> — you typed a bare "continue"</Text>
      </Box>

      <Box flexDirection="row">
        <Text dimColor>resolves to: </Text>
        <Text color="white">{label.replace(/^▶\s*Continue\s*→\s*/, '')}</Text>
      </Box>

      {source === 'open' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">No pending todo or suggestion — "continue" has no anchor here.</Text>
          <Text dimColor>
            If you proceed, I'll choose the next step myself from the conversation and project
            state. That's a guess — it can drift from what you meant.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{preview}</Text>
        </Box>
      )}

      <Text dimColor>─────────────────</Text>
      <Box flexDirection="row">
        <Text>
          <Text bold color="green">
            [Enter]
          </Text>
          <Text dimColor>
            {autoProceedSecs != null ? ` proceed (auto ${autoProceedSecs}s) · ` : ' proceed anyway · '}
          </Text>
          <Text bold color="cyan">
            [e]
          </Text>
          <Text dimColor> {source === 'open' ? 'type what to continue' : 'edit'} · </Text>
          <Text bold color="red">
            [Esc]
          </Text>
          <Text dimColor> cancel</Text>
        </Text>
      </Box>
    </Box>
  );
}
