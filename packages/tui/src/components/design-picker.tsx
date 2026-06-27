import type { DesignKitEntry } from '@wrongstack/core';
import type React from 'react';
import { Box, Text } from '../ink.js';

export interface DesignPickerProps {
  kits: DesignKitEntry[];
  selected: number;
  stack: string;
}

/**
 * Design Studio kit picker overlay (opened by `/design`). Presentational only —
 * navigation/selection state lives in the reducer; Enter runs `/design <id>
 * <stack>` through the normal submit path, which pins the kit + loads its spec.
 */
export function DesignPicker({ kits, selected, stack }: DesignPickerProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        ━━ Design Studio · pick a kit ━━
      </Text>
      <Text dimColor>↑/↓ navigate · ←/→ stack:{stack} · Enter apply · Esc cancel</Text>
      {kits.length === 0 ? (
        <Text dimColor>No design kits installed.</Text>
      ) : (
        kits.map((kit, i) => (
          <Box key={kit.id} flexDirection="column">
            <Text inverse={i === selected} {...(i === selected ? { color: 'cyan' } : {})}>
              {i === selected ? '› ' : '  '}
              <Text bold>{kit.id.padEnd(20)}</Text>
              <Text dimColor>{kit.aesthetic}</Text>
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}
