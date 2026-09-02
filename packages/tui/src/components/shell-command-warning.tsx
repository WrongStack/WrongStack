import { Box, Text, useInput } from '../ink.js';
import { writeOut } from '@wrongstack/core/utils';
import React from 'react';

export type ShellCommandWarningDecision = 'yes' | 'no' | 'dont-show-again';

interface ShellCommandWarningProps {
  command: string;
  onDecision: (decision: ShellCommandWarningDecision) => void;
}

export function truncateShellCommandWarningCommand(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function ShellCommandWarning({
  command,
  onDecision,
}: ShellCommandWarningProps): React.ReactElement {
  React.useEffect(() => {
    writeOut('\x07');
  }, []);

  useInput((input, _key) => {
    if (!input || input === '\r' || input === '\n') return;
    const ch = input.toLowerCase();
    if (ch === 'y') onDecision('yes');
    if (ch === 'n') onDecision('no');
    if (ch === 'd') onDecision('dont-show-again');
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box flexDirection="row">
        <Text bold color="yellow">
          ⚠ SHELL COMMAND
        </Text>
        <Text> </Text>
        <Text bold color="white">
          !{truncateShellCommandWarningCommand(command)}
        </Text>
      </Box>
      <Text dimColor>This will execute in your shell via /dev. Only run commands you trust.</Text>
      <Text dimColor>─────────────────</Text>
      <Box flexDirection="row">
        <Text>
          <Text bold color="green">
            [y]
          </Text>
          <Text dimColor>es </Text>
          <Text bold color="red">
            [n]
          </Text>
          <Text dimColor>o </Text>
          <Text bold color="cyan">
            [d]
          </Text>
          <Text dimColor>ont show again</Text>
        </Text>
      </Box>
    </Box>
  );
}
