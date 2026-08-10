import type React from 'react';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text } from '../ink.js';
import type { ThemeName, ThemePickerOption } from '../theme.js';

export interface ThemePickerProps {
  options: readonly ThemePickerOption[];
  selected: number;
  activeId: ThemeName;
  hint?: string | undefined;
}

/**
 * Interactive theme picker. Mirrors the autonomy-picker visual pattern
 * (bordered box, ↑/↓ navigate, Enter apply, Esc cancel) so the two
 * pickers look and feel consistent. The currently active preset is
 * highlighted with a `[active]` marker so the user can see whether
 * their selection will actually change anything.
 *
 * The list is windowed via {@link useWindowedPicker} so 15+ presets stay
 * usable on small terminals — a top-aligned `…` marker appears when the
 * focused row is below the start of the visible window.
 */
export function ThemePicker({
  options,
  selected,
  activeId,
  hint,
}: ThemePickerProps): React.ReactElement {
  const { start, end, hasAbove, hasBelow } = useWindowedPicker({
    total: options.length,
    selected,
    chromeRows: 4,
  });
  // Empty list — render the chrome but no body rows. Defensive against
  // misconfigured callers; the slash command normally always supplies
  // the canonical THEME_OPTIONS.
  const visibleOptions = options.slice(start, end);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="cyan" bold>
        ━━ TUI Theme ━━
      </Text>
      <Text dimColor>↑/↓ navigate · Enter apply · Esc cancel</Text>
      {hasAbove ? <Text dimColor>  … {start} more above</Text> : null}
      {visibleOptions.map((opt, j) => {
        const i = start + j;
        const isActive = opt.id === activeId;
        const isSelected = i === selected;
        return (
          <Text key={opt.id} inverse={isSelected} {...(isSelected ? { color: 'cyan' } : {})}>
            {isSelected ? '› ' : '  '}
            <Text bold>{opt.name.padEnd(18)}</Text>
            <Text dimColor>{opt.description}</Text>
            {isActive ? <Text color="green"> [active]</Text> : null}
          </Text>
        );
      })}
      {hasBelow ? (
        <Text dimColor>  … {options.length - end} more below</Text>
      ) : null}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
