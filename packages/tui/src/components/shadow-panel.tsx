import { Box, Text } from '../ink.js';
import type React from 'react';

export interface ShadowState {
  activeId: string | null;
  running: boolean;
  model: string;
  intervalMs: number;
}

export interface ShadowPanelProps {
  shadow: ShadowState;
  hint?: string | undefined;
}

export function ShadowPanel({
  shadow,
  hint,
}: ShadowPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="blue">
        ━━ Shadow Agent ━━
      </Text>
      <Text dimColor>s start · t stop · i cycle interval · m cycle model · Esc close</Text>

      <Box marginTop={1} flexDirection="column">
        {/* Status */}
        <Box>
          <Text bold>Status: </Text>
          {shadow.running ? (
            <Text color="green">● running</Text>
          ) : (
            <Text color="gray">○ stopped</Text>
          )}
          {shadow.activeId ? (
            <Text dimColor>{`  ${shadow.activeId.slice(0, 12)}…`}</Text>
          ) : null}
        </Box>

        {/* Model */}
        <Box marginTop={1}>
          <Text bold>Model: </Text>
          <Text color="cyan">{shadow.model}</Text>
        </Box>

        {/* Interval */}
        <Box marginTop={1}>
          <Text bold>Interval: </Text>
          <Text color="yellow">{shadow.intervalMs >= 1000 ? `${shadow.intervalMs / 1000}s` : `${shadow.intervalMs}ms`}</Text>
          <Text dimColor>  (min 5s)</Text>
        </Box>

        {/* Actions legend */}
        <Box marginTop={1}>
          <Text dimColor>
            {shadow.running
              ? 'Press t to stop the Shadow Agent'
              : 'Press s to start the Shadow Agent'}
          </Text>
        </Box>
      </Box>

      {hint ? (
        <Box marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
