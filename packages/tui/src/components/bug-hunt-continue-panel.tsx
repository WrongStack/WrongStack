import React from 'react';
import { Box, Text, useInput } from '../ink.js';

export type BugHuntContinueDecision = 'yes' | 'stop';

interface BugHuntContinuePanelProps {
  completedRounds: number;
  totalRounds?: number | undefined;
  onDecision: (decision: BugHuntContinueDecision) => void;
}

/**
 * The deliberate pause between Proof-Driven Bug Hunter rounds. The timeout is an
 * affirmative default: it keeps a deliberately unbounded hunt moving, while
 * Esc/S makes stopping immediate and unambiguous.
 */
export function BugHuntContinuePanel({
  completedRounds,
  totalRounds,
  onDecision,
}: BugHuntContinuePanelProps): React.ReactElement {
  const [remaining, setRemaining] = React.useState(30);
  const decidedRef = React.useRef(false);
  const decide = React.useCallback(
    (decision: BugHuntContinueDecision) => {
      if (decidedRef.current) return;
      decidedRef.current = true;
      onDecision(decision);
    },
    [onDecision],
  );

  React.useEffect(() => {
    const id = setInterval(() => {
      setRemaining((current) => {
        if (current <= 1) {
          clearInterval(id);
          decide('yes');
          return 0;
        }
        return current - 1;
      });
    }, 1_000);
    return () => clearInterval(id);
  }, [decide]);

  useInput((input, key) => {
    if (key.return || input.toLowerCase() === 'y') decide('yes');
    if (key.escape || input.toLowerCase() === 's' || input.toLowerCase() === 'n') decide('stop');
  });

  const roundLabel = totalRounds
    ? `Round ${completedRounds}/${totalRounds} completed`
    : `Round ${completedRounds} completed`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Proof-Driven Bug Hunter — {roundLabel}
      </Text>
      <Text>Continue with the next proof-driven round?</Text>
      <Text dimColor>Automatically continuing in {remaining}s.</Text>
      <Text dimColor>─────────────────</Text>
      <Text>
        <Text bold color="green">
          [Enter/Y]
        </Text>
        <Text dimColor> Yes · </Text>
        <Text bold color="red">
          [Esc/S/N]
        </Text>
        <Text dimColor> Stop</Text>
      </Text>
    </Box>
  );
}
