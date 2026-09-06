import type React from 'react';
import { Box, Text } from '../ink.js';

interface BugHuntRunningPanelProps {
  currentRound: number;
  totalRounds?: number | undefined;
}

/** A compact, non-blocking marker for the bug-hunt round currently in flight. */
export function BugHuntRunningPanel({
  currentRound,
  totalRounds,
}: BugHuntRunningPanelProps): React.ReactElement {
  const roundLabel = totalRounds
    ? `Round ${currentRound}/${totalRounds}`
    : `Round ${currentRound}`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        {'◇ BUG HUNTING STARTED'}
      </Text>
      <Text>
        <Text bold color="cyan">{roundLabel}</Text>
        <Text dimColor>{'  · proof-driven scan, reproduce, fix, verify'}</Text>
      </Text>
    </Box>
  );
}
