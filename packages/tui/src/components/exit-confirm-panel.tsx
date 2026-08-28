import type React from 'react';
import { Box, Text } from '../ink.js';

interface ExitConfirmPanelProps {
  leaderActive: boolean;
  subagentCount: number;
  backgroundCount?: number | undefined;
}

export interface ExitConfirmationKey {
  escape?: boolean | undefined;
  return?: boolean | undefined;
}

type ExitConfirmationDecision = true | false | null;

/**
 * Deterministic keyboard state machine shared by the App input router and
 * regression tests. Returning `null` means "keep waiting" — the panel
 * stays open with no decision committed yet.
 *
 * `/exit` requires an explicit acknowledgement while any work is in flight,
 * so any printable key is ignored. Pressing Enter confirms, pressing Esc
 * cancels. This mirrors the `/clear` invariant: never tear down in-flight
 * work without an affirmative keystroke.
 */
export function exitConfirmationDecision(
  input: string,
  key: ExitConfirmationKey,
): ExitConfirmationDecision {
  if (key.escape) return false;
  if (key.return) return true;
  // Swallow printable input so a stray key can't be interpreted as a yes/no.
  void input;
  return null;
}

/**
 * Modal confirmation for `/exit` while work is active. The panel makes the
 * active fleet obvious so the user understands what `/exit` would tear down
 * before they press Enter.
 */
export function ExitConfirmPanel({
  leaderActive,
  subagentCount,
  backgroundCount = 0,
}: ExitConfirmPanelProps): React.ReactElement {
  const activeParts = [
    leaderActive ? 'leader run' : null,
    subagentCount > 0 ? `${subagentCount} sub-agent${subagentCount === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={1} marginY={1}>
      <Text bold color="red">
        ⚠ EXIT BLOCKED — ACTIVE WORK
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>
          Still running:{' '}
          <Text bold color="yellow">
            {activeParts.join(' + ')}
          </Text>
        </Text>
        <Text dimColor>
          Exiting will terminate every running subagent and discard the current session. Press{' '}
          <Text bold color="green">
            Enter
          </Text>{' '}
          to confirm or <Text bold>Esc</Text> to cancel.
        </Text>
        {backgroundCount > 0 ? (
          <Text color="green">
            {backgroundCount} detached background process{backgroundCount === 1 ? '' : 'es'} will
            remain running.
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
