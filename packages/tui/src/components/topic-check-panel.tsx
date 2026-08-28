import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';

interface TopicCheckPanelProps {
  prompt: string;
}

/** Short-lived submit gate shown only when local continuity checks are ambiguous. */
export function TopicCheckPanel({ prompt }: TopicCheckPanelProps): React.ReactElement {
  const preview = prompt.replace(/\s+/g, ' ').trim();
  return (
    <Box
      alignSelf="stretch"
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
    >
      <Text bold color={theme.brand}>
        CONTEXT ADVISOR · CHECKING TOPIC CONTINUITY
      </Text>
      <Text color={theme.textMuted}>
        Long history detected; checking whether a fresh context would avoid unrelated cache/history.
      </Text>
      <Text color={theme.textSecondary}>
        {preview.length <= 180 ? preview : `${preview.slice(0, 179)}…`}
      </Text>
    </Box>
  );
}
