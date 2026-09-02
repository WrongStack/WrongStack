import type { Mode } from '@wrongstack/core/types';
import type React from 'react';
import { Box, Text } from '../ink.js';

export interface ModeOption {
  id: string;
  name: string;
  description: string;
  family: 'lite' | 'deep' | 'balanced' | 'custom';
  isActive: boolean;
}

interface ModePickerProps {
  modes: ModeOption[];
  selected: number;
  hint?: string | undefined;
}

/** Build the display options from base modes + active id. */
function modeFamily(mode: Mode): ModeOption['family'] {
  if (mode.tags?.includes('lite')) return 'lite';
  if (mode.tags?.includes('deep')) return 'deep';
  if (mode.tags?.includes('balanced') || mode.id === 'default') return 'balanced';
  return 'custom';
}

export function toModeOptions(modes: Mode[], activeId: string | null): ModeOption[] {
  return modes.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    family: modeFamily(m),
    isActive: m.id === activeId,
  }));
}

function familyLabel(family: ModeOption['family']): string {
  switch (family) {
    case 'lite':
      return 'lite';
    case 'deep':
      return 'deep';
    case 'balanced':
      return 'base';
    case 'custom':
      return 'custom';
  }
}

function familyColor(family: ModeOption['family']): 'green' | 'magenta' | 'blue' | 'yellow' {
  switch (family) {
    case 'lite':
      return 'green';
    case 'deep':
      return 'magenta';
    case 'balanced':
      return 'blue';
    case 'custom':
      return 'yellow';
  }
}

export function ModePicker({ modes, selected, hint }: ModePickerProps): React.ReactElement {
  const activeMode = modes.find((mode) => mode.isActive);
  const modeMeta = `${modes.length} mode${modes.length === 1 ? '' : 's'}`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Mode Selection ━━ <Text dimColor>{modeMeta}</Text>
      </Text>
      <Text dimColor>
        Current: {activeMode ? activeMode.name : 'none'} · ↑/↓ navigate · Enter select · Esc cancel
      </Text>
      {modes.length === 0 ? (
        <Text dimColor>No modes available.</Text>
      ) : (
        modes.map((opt, i) => (
          <Text
            key={opt.id}
            inverse={i === selected}
            {...(i === selected ? { color: 'cyan' } : {})}
          >
            {i === selected ? '› ' : '  '}
            <Text bold>{opt.name.padEnd(18)}</Text>
            <Text color={familyColor(opt.family)}>[{familyLabel(opt.family)}]</Text>
            <Text dimColor> {opt.description}</Text>
            {opt.isActive ? <Text color="green"> ● active</Text> : null}
          </Text>
        ))
      )}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
