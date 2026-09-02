import { Box, Text } from '../ink.js';
import type React from 'react';
import { F_KEY_PANEL_ENTRIES } from '../f-key-panels.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';

export { F_KEY_PANEL_ENTRIES as F_KEY_ENTRIES } from '../f-key-panels.js';

interface FKeyPickerProps {
  selected: number;
}

/**
 * Keyboard-navigable F-key panel picker.
 * Shown when the user types `/f` in the TUI.
 * Arrow keys navigate, Enter opens the selected panel, Esc closes.
 */
export function FKeyPicker({ selected }: FKeyPickerProps): React.ReactElement {
  const size = useMonitorSize();
  const safeSelected = Math.min(Math.max(0, selected), F_KEY_PANEL_ENTRIES.length - 1);
  const limit = Math.max(3, size.contentRows - 2);
  const window = panelWindow(F_KEY_PANEL_ENTRIES.length, safeSelected, limit);
  const visible = F_KEY_PANEL_ENTRIES.slice(window.start, window.end);

  return (
    <MonitorShell
      accent={theme.accent}
      icon={glyphs.tools}
      title="FUNCTION KEYS"
      kicker={size.columns >= 78 ? 'panel launcher' : undefined}
      right={<Text color={theme.textMuted}>{F_KEY_PANEL_ENTRIES.length} surfaces</Text>}
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="navigate" color={theme.accent} />
          <KeyCap keyName="Enter" label="open" color={theme.success} />
          <KeyCap keyName="Esc" label="close" color={theme.error} />
        </Box>
      }
    >
      {window.above > 0 ? <Text color={theme.textMuted}> ↑ {window.above} panels</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {visible.map((entry, i) => {
          const idx = window.start + i;
          const isSelected = idx === safeSelected;

          return (
            <Box key={entry.key || `entry-${idx}`}>
              <Text color={isSelected ? theme.accent : theme.textMuted}>
                {isSelected ? '› ' : '  '}
              </Text>
              {entry.key > 0 ? (
                <Text color={isSelected ? theme.accent : theme.textMuted} bold>
                  F{String(entry.key).padEnd(2)}
                </Text>
              ) : (
                <Text color={isSelected ? theme.accent : theme.textMuted} bold>
                  {'   '}
                </Text>
              )}
              <Text color={isSelected ? theme.textPrimary : theme.textSecondary} bold={isSelected}>
                {'  '}
                {truncatePanelText(
                  entry.label,
                  Math.max(14, size.columns >= 92 ? 34 : size.contentWidth - 12),
                )}
              </Text>
              {size.columns >= 92 ? (
                <>
                  <Box flexGrow={1} />
                  <Text color={theme.textMuted}>
                    {truncatePanelText(entry.helpDescription, 42)}
                  </Text>
                </>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {window.below > 0 ? <Text color={theme.textMuted}> ↓ {window.below} panels</Text> : null}
    </MonitorShell>
  );
}
