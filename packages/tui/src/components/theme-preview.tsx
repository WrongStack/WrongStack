import type React from 'react';
import { Box, Text } from '../ink.js';
import { resolveSyntaxColor, themePresets, type ThemeName } from '../theme.js';

interface ThemePreviewProps {
  /** Preset whose palette this preview renders. Must exist in `themePresets`. */
  presetId: ThemeName;
  /** Whether this preset is the currently applied one (`[active]` marker). */
  active: boolean;
  /**
   * Preview column width in terminal columns. The component hides the
   * full sample and falls back to a compact header when the caller has less
   * than this much room (narrow terminals with the sidebar open).
   */
  columns: number;
  /**
   * Vertical budget for the whole preview box, matching the picker's
   * `maxRows`. The sample is trimmed from the bottom (diff → syntax →
   * status → palette) until it fits, so the preview can never be taller
   * than the list it sits beside on a short terminal.
   */
  maxRows?: number | undefined;
}

/**
 * Live palette preview for the `/theme` picker's split-screen layout.
 *
 * This is a PRESENTATIONAL snapshot renderer: it reads the frozen preset
 * object from `themePresets` and draws a miniature of the TUI's own chrome
 * (bordered frame, USER/assistant/tool lines, status chips, diff wash) using
 * that preset's hex tokens. It deliberately never touches the live `theme`
 * bag and never calls `setActiveTheme` — navigating the list must only
 * *show* a candidate palette; Enter alone applies it (see
 * `onThemePickerEnter` in app.tsx). That keeps previewing side-effect free
 * and lets the picker re-render on every arrow key without state churn.
 *
 * Color tokens from a preset are hex strings, so they are passed straight to
 * Ink's `color` / `backgroundColor` — the `softColor` shim in ink.tsx
 * passes hex through untouched.
 */
export function ThemePreview({
  presetId,
  active,
  columns,
  maxRows,
}: ThemePreviewProps): React.ReactElement {
  const preset = themePresets[presetId];
  // Defensive: the picker normally supplies a canonical THEME_OPTIONS id, so
  // an unknown id means a misconfigured caller — render nothing rather than
  // crashing the whole picker over a preview.
  if (!preset) {
    return <Text dimColor>unknown preset {presetId}</Text>;
  }

  const compact = columns < 40;

  // The sample syntax line uses the preset's resolved syntax palette so the
  // preview shows what syntax highlighting would actually look like.
  const syntaxKeyword = resolveSyntaxColor('keyword', preset);
  const syntaxString = resolveSyntaxColor('string', preset);

  // Trim-from-bottom section budget: the preview must never be taller than
  // the picker's `maxRows` (it sits BESIDE the list, so an 18-row sample on
  // a 12-row budget would overflow the very fit the picker promises). Each
  // section declares its row cost; sections are included top-down while the
  // cumulative cost fits the budget. The header + border always render.
  const contentBudget = maxRows === undefined ? Infinity : Math.max(0, maxRows - 3);
  const sections: ReadonlyArray<{ key: string; cost: number; render: React.ReactElement }> = [
    {
      key: 'sample',
      cost: 6,
      render: (
        <Box flexDirection="column">
          <Text dimColor>sample</Text>
          <Box flexDirection="column">
            <Text color={preset.user} bold>
              USER:
            </Text>
            <Text color={preset.textPrimary}> Summarize the changes in this session.</Text>
            <Text color={preset.assistant} bold>
              ASSISTANT:
            </Text>
            <Text color={preset.textPrimary}> I reviewed the diff and updated the picker.</Text>
            <Text color={preset.tool}>
              {'  '}✳ tool: read · edit · test <Text color={preset.success}>✓ passed</Text>
            </Text>
          </Box>
        </Box>
      ),
    },
    {
      key: 'diff',
      cost: 3,
      render: (
        <Box flexDirection="column">
          <Text dimColor>diff</Text>
          <Box flexDirection="column">
            <Text backgroundColor={preset.diffAddBg} color={preset.success}>
              {'  '}+ const visible = clamp(rows)
            </Text>
            <Text backgroundColor={preset.diffDelBg} color={preset.error}>
              {'  '}- const visible = rows
            </Text>
          </Box>
        </Box>
      ),
    },
    {
      key: 'syntax',
      cost: 2,
      render: (
        <Box flexDirection="column">
          <Text dimColor>syntax</Text>
          <Text color={preset.textPrimary}>
            {'  '}
            <Text color={syntaxKeyword}>const</Text> <Text color={preset.textPrimary}>name</Text>{' '}
            <Text color={preset.textSecondary}>=</Text>{' '}
            <Text color={syntaxString}>'catppuccin'</Text>
            <Text color={preset.textSecondary}>;</Text>
          </Text>
        </Box>
      ),
    },
    {
      key: 'status',
      cost: 2,
      render: (
        <Box flexDirection="column">
          <Text dimColor>status</Text>
          <Box flexDirection="row">
            <Text color={preset.success}> ✓ ok </Text>
            <Text color={preset.warn}> ! wait </Text>
            <Text color={preset.error}> ✕ fail </Text>
          </Box>
        </Box>
      ),
    },
    {
      key: 'palette',
      cost: 2,
      render: (
        <Box flexDirection="column">
          <Text dimColor>palette</Text>
          <Box flexDirection="row">
            <Text backgroundColor={preset.accent}> </Text>
            <Text backgroundColor={preset.brandPrimary}> </Text>
            <Text backgroundColor={preset.brandAccent}> </Text>
            <Text backgroundColor={preset.surface}> </Text>
            <Text backgroundColor={preset.surfaceRaised}> </Text>
            <Text backgroundColor={preset.diffAddBg}> </Text>
            <Text backgroundColor={preset.diffDelBg}> </Text>
          </Box>
        </Box>
      ),
    },
  ];

  let used = 0;
  const visible: React.ReactElement[] = [];
  for (const section of sections) {
    if (used + section.cost > contentBudget) break;
    visible.push(
      <Box key={section.key} flexDirection="column">
        {section.render}
      </Box>,
    );
    used += section.cost;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={preset.borderDefault} paddingX={1}>
      <Text color={preset.brandPrimary} bold>
        {presetId}
        {active ? <Text color={preset.success}> [active]</Text> : null}
      </Text>
      {compact ? <Text dimColor>… preview hidden on narrow terminals</Text> : visible}
    </Box>
  );
}
