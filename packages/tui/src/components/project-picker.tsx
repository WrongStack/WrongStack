import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';

/** A single row in the project picker. Matches the CLI's PickerItem shape. */
export interface ProjectPickerItem {
  key: string;
  label: string;
  subtitle?: string | undefined;
  meta?: string | undefined;
  kind: 'project' | 'action';
}

interface ProjectPickerProps {
  /** Already-filtered items. Navigation indices target this list directly. */
  items: ProjectPickerItem[];
  /** Index into `items`. Guaranteed to never point at a divider. */
  selected: number;
  /** Current filter text. */
  filter: string;
  /** Optional status/error hint shown below the list. */
  hint?: string | undefined;
}

function actionIcon(key: string): string {
  if (key === 'new-session') return glyphs.sessions;
  if (key === 'prev-sessions') return glyphs.clock;
  if (key === 'quit') return glyphs.failure;
  return glyphs.task;
}

/** Responsive project command center opened by F1. */
export function ProjectPicker({
  items,
  selected,
  filter,
  hint,
}: ProjectPickerProps): React.ReactElement {
  const size = useMonitorSize();
  const projectCount = items.filter((item) => item.kind === 'project').length;
  const selectableCount = items.filter((item) => item.key !== '__divider__').length;
  const compact = size.rows < 16;
  const limit = compact ? 1 : Math.max(1, Math.min(12, Math.floor(size.contentRows / 1.5)));
  const window = panelWindow(items.length, selected, limit);
  const visible = items.slice(window.start, window.end);
  const labelWidth = Math.max(12, size.contentWidth - 16);

  return (
    <MonitorShell
      wheelScroll={false}
      accent={theme.accent}
      icon={glyphs.folder}
      title="PROJECTS"
      kicker="workspace switcher"
      right={
        <Text color={theme.textMuted}>
          {projectCount} project{projectCount === 1 ? '' : 's'}
        </Text>
      }
      footer={
        <Box gap={1} flexWrap="wrap">
          <KeyCap keepTogether keyName="↑↓" label="navigate" />
          <KeyCap keepTogether keyName="Enter" label="open" color={theme.success} />
          <KeyCap keepTogether keyName="F1/Esc" label="close" color={theme.error} />
        </Box>
      }
    >
      {size.rows >= 6 ? (
        <Box height={1} marginTop={compact ? 0 : 1}>
          <Text color={filter ? theme.warn : theme.textMuted}>{glyphs.prompt} </Text>
          <Text color={filter ? theme.textPrimary : theme.textMuted}>
            {filter ||
              (size.columns < 64 ? 'Filter projects…' : 'Type to filter projects and actions')}
          </Text>
          {filter ? <Text color={theme.accent}>█</Text> : null}
          <Box flexGrow={1} />
          {size.columns >= 64 ? (
            <Text color={theme.textMuted}>{selectableCount} choices</Text>
          ) : null}
        </Box>
      ) : null}

      {size.rows >= 8 && window.above > 0 ? (
        <Text color={theme.textMuted}> ↑ {window.above} hidden</Text>
      ) : null}

      {visible.length === 0 ? (
        <EmptyPanelState
          icon={glyphs.folder}
          title="No matching projects"
          detail="Clear the filter or add a project with /project add."
        />
      ) : (
        <Box flexDirection="column" marginTop={compact ? 0 : 1}>
          {visible.map((item, offset) => {
            const index = window.start + offset;
            const isSelected = index === selected;
            if (item.key === '__divider__') {
              return (
                <Box key={`${item.key}-${index}`} height={1}>
                  <Text color={theme.textMuted}>{'─'.repeat(Math.min(32, size.contentWidth))}</Text>
                </Box>
              );
            }
            const icon = item.kind === 'project' ? glyphs.folder : actionIcon(item.key);
            const accent = item.kind === 'project' ? theme.accent : theme.warn;
            return (
              <Box
                key={item.key}
                flexDirection="column"
                {...(isSelected && theme.supportsBackground
                  ? { backgroundColor: theme.surfaceRaised }
                  : {})}
              >
                <Box height={1}>
                  <Text color={isSelected ? accent : theme.textMuted}>
                    {isSelected ? '▎' : ' '}
                  </Text>
                  <Text color={accent}> {icon} </Text>
                  <Text
                    color={isSelected ? theme.textPrimary : theme.textSecondary}
                    bold={isSelected}
                  >
                    {truncatePanelText(item.label, labelWidth)}
                  </Text>
                  <Box flexGrow={1} />
                  {item.meta ? (
                    <Text color={isSelected ? accent : theme.textMuted}>
                      {truncatePanelText(item.meta, 18)}
                    </Text>
                  ) : null}
                </Box>
                {item.subtitle && size.rows >= 16 ? (
                  <Box height={1}>
                    <Text color={isSelected ? accent : theme.textMuted}> └─ </Text>
                    <Text color={theme.textMuted}>
                      {truncatePanelText(item.subtitle, labelWidth)}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}

      {size.rows >= 8 && window.below > 0 ? (
        <Text color={theme.textMuted}> ↓ {window.below} hidden</Text>
      ) : null}
      {hint ? (
        <Text color={theme.warn}>
          {glyphs.warning} {hint}
        </Text>
      ) : null}
    </MonitorShell>
  );
}
