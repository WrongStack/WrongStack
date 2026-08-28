import { Box, Text, useInput } from '../ink.js';
import type React from 'react';

interface EscConfirmPromptProps {
  runningTools: string[];
  subagentCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog shown when the user presses Esc mid-iteration and
 * `confirmExit` is enabled. Prevents accidental interruption of a running
 * agent — the agent keeps working until the user explicitly says yes.
 *
 * - y / Enter → confirm the interrupt
 * - n / Esc → cancel, let the agent continue
 */
export function EscConfirmPrompt({
  runningTools,
  subagentCount,
  onConfirm,
  onCancel,
}: EscConfirmPromptProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    const ch = input.toLowerCase();
    if (ch === 'y' || key.return) {
      onConfirm();
    } else if (ch === 'n') {
      onCancel();
    }
  });

  const running = runningTools.length;
  const toolLabel = running === 1 ? runningTools[0] : null;
  const toolHint = toolLabel ? ` (${toolLabel})` : running > 1 ? ` (${running} tools)` : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box flexDirection="row">
        <Text bold color="yellow">
          ⏸ Interrupt the current run?
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>
          The agent is working{toolHint}.
          {subagentCount > 0
            ? ` ${subagentCount} subagent${subagentCount === 1 ? '' : 's'} active.`
            : ''}
        </Text>
        <Text dimColor>
          Stop to give a new direction now, or let it finish.
        </Text>
      </Box>
      <Text dimColor>─────────────────</Text>
      <Box flexDirection="row">
        <Text>
          <Text bold color="green">
            [y]
          </Text>
          <Text dimColor>es — stop and steer </Text>
          <Text bold color="red">
            [n]
          </Text>
          <Text dimColor>o / Esc — keep running</Text>
        </Text>
      </Box>
    </Box>
  );
}
