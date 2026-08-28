import type { DesignKitEntry } from '@wrongstack/core/types';
import type React from 'react';
import { Box, Text } from '../ink.js';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';

interface DesignPickerProps {
  kits: DesignKitEntry[];
  selected: number;
  stack: string;
}

/**
 * Design Studio kit picker overlay (opened by `/design`). Presentational only —
 * navigation/selection state lives in the reducer; Enter runs `/design <id>
 * <stack>` through the normal submit path, which pins the kit + loads its spec.
 *
 * Windowed via {@link useWindowedPicker} so 50+ installed kits stay
 * navigable on small terminals.
 */
export function DesignPicker({ kits, selected, stack }: DesignPickerProps): React.ReactElement {
  const { start, end, hasAbove, hasBelow } = useWindowedPicker({
    total: kits.length,
    selected,
    chromeRows: 4,
    // 2 marker slots — the `… more above/below` rows render below the header
    // and hint but were never counted in the chrome, so a windowed list
    // overflowed its own budget by 2 rows on short terminals.
    markerRows: 2,
  });
  const visibleKits = kits.slice(start, end);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        ━━ Design Studio · pick a kit ━━
      </Text>
      <Text dimColor>↑/↓ navigate · ←/→ stack:{stack} · Enter apply · Esc cancel</Text>
      {kits.length === 0 ? (
        <Text dimColor>No design kits installed.</Text>
      ) : (
        <>
          {hasAbove ? <Text dimColor>  … {start} more above</Text> : null}
          {visibleKits.map((kit, j) => {
            const i = start + j;
            return (
              <Box key={kit.id} flexDirection="column">
                <Text inverse={i === selected} {...(i === selected ? { color: 'cyan' } : {})}>
                  {i === selected ? '› ' : '  '}
                  <Text bold>{kit.id.padEnd(20)}</Text>
                  <Text dimColor>{kit.aesthetic}</Text>
                </Text>
              </Box>
            );
          })}
          {hasBelow ? (
            <Text dimColor>  … {kits.length - end} more below</Text>
          ) : null}
        </>
      )}
    </Box>
  );
}
