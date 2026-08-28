import type React from 'react';
import { Box, Text } from '../ink.js';

interface SlashConfirmPanelProps {
  question: string;
  defaultYes: boolean;
}

interface SlashConfirmationKey {
  escape?: boolean | undefined;
  return?: boolean | undefined;
}

/** Resolve a generic confirmation key; null means keep waiting. */
export function slashConfirmationDecision(
  input: string,
  key: SlashConfirmationKey,
  defaultYes: boolean,
): boolean | null | 'cancel' {
  if (key.escape) return 'cancel';
  if (key.return) return defaultYes;
  const normalized = input.toLowerCase();
  if (normalized === 'y') return true;
  if (normalized === 'n') return false;
  if (normalized === 'q') return 'cancel';
  return null;
}

/** Visible modal used by slash commands that previously prompted via readline. */
export function SlashConfirmPanel({
  question,
  defaultYes,
}: SlashConfirmPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        ? CONFIRM ACTION
      </Text>
      <Box marginTop={1}>
        <Text>{question}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text bold color="green">
            [y]
          </Text>
          es{'  '}
          <Text bold color="red">
            [n]
          </Text>
          o{'  '}
          <Text bold>Enter</Text> = {defaultYes ? 'yes' : 'no'}
          {'  '}
          <Text bold>Esc/q</Text> = cancel
        </Text>
      </Box>
    </Box>
  );
}
