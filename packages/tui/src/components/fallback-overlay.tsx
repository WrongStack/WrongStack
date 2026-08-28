import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';

export interface FallbackCandidate {
  providerId: string;
  model: string;
}

interface FallbackOverlayProps {
  requestId: string;
  from: { providerId: string; model: string };
  status: number;
  candidates: FallbackCandidate[];
  autoSwitchSeconds: number;
  selected: number;
  /** Called when the user manually picks a model (Enter or countdown expiry on selected). */
  onChoose: (choice: { providerId: string; model: string } | null) => void;
  /** Called when the selection should move (up/down arrows). */
  onMove: (delta: number) => void;
}

/**
 * Fallback model overlay — shown when `provider.fallback_pending` fires.
 *
 * Displays the failed model, a list of fallback candidates, and a countdown.
 * The user can:
 * - Use ↑/↓ to highlight a candidate and press Enter to pick it.
 * - Press Esc to accept the auto-switch (null → chain head).
 * - Wait for the countdown to expire → auto-switch to the highlighted entry.
 *
 * The overlay always appears on top of whatever else is rendered, ensuring
 * the user is notified on every model switch — even when a fallback list
 * is already visible elsewhere.
 */
export function FallbackOverlay({
  from,
  status,
  candidates,
  autoSwitchSeconds,
  selected,
  onChoose,
  onMove,
}: FallbackOverlayProps): React.ReactElement {
  const [remaining, setRemaining] = useState(Math.max(1, autoSwitchSeconds));
  const resolvedRef = useRef(false);
  // The countdown interval below is mounted once (empty deps) so selection
  // moves don't restart it — but its closure must read the CURRENT highlight
  // at expiry, not the first-render values. Keep the live values in refs
  // updated on every render so the interval never goes stale.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          if (!resolvedRef.current) {
            resolvedRef.current = true;
            // Auto-switch: pick the currently highlighted entry (or null
            // if there are no candidates — shouldn't happen but is safe).
            const chosen = candidatesRef.current[selectedRef.current] ?? null;
            onChooseRef.current(chosen);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_input, key) => {
    if (resolvedRef.current) return;
    if (key.upArrow) {
      onMove(-1);
      return;
    }
    if (key.downArrow) {
      onMove(1);
      return;
    }
    if (key.return) {
      resolvedRef.current = true;
      const chosen = candidates[selected] ?? null;
      onChoose(chosen);
      return;
    }
    if (key.escape) {
      resolvedRef.current = true;
      onChoose(null);
    }
  });

  const fromLabel = `${from.providerId}/${from.model}`;

  return (
    <Box
      alignSelf="stretch"
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warn}
      paddingX={1}
    >
      {/* Header */}
      <Box height={1}>
        <Text color={theme.warn} bold>
          ⚠ MODEL FALLBACK
        </Text>
        <Text color={theme.textMuted}> </Text>
        <Text color={theme.textSecondary}>
          {fromLabel} returned {status}
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.warn}>auto-switch in {remaining}s</Text>
      </Box>

      {/* Candidate list */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted} dimColor>
          Select a fallback model (↑/↓ to move, Enter to pick, Esc for auto):
        </Text>
        {candidates.map((c, i) => {
          const isSel = i === selected;
          const label = `${c.providerId}/${c.model}`;
          return (
            <Box key={`fb-${i}`} height={1}>
              <Text color={isSel ? theme.warn : theme.textMuted}>
                {isSel ? '▸ ' : '  '}
              </Text>
              <Text color={isSel ? theme.textPrimary : theme.textSecondary} bold={isSel}>
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Footer hint */}
      <Box height={1} marginTop={1}>
        <Text color={theme.textMuted} dimColor>
          Enter picks · Esc auto-switches · countdown picks highlighted entry
        </Text>
      </Box>
    </Box>
  );
}
