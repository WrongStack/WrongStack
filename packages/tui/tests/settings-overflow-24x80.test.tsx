/**
 * Regression test: the /settings picker must never overflow a small
 * terminal (24 rows × 80 cols — the Ubuntu terminal default).
 *
 * Before the fix, VISIBLE_FIELDS forced 8 field rows. On an 80-col
 * terminal each field's detail text wrapped to 2 lines (16 field rows),
 * plus section headers and chrome exceeded 24 rows. Ink couldn't erase
 * the overflowing frame cleanly, stranding old rows in native scrollback
 * and producing the garbled/repeated "next steps" text block the user
 * reported.
 *
 * This test uses the real-TTY harness so yoga runs a real layout against
 * a 24×80 fake terminal — the captured frame is exactly what a user
 * would see.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderRealTty, settle } from './helpers/real-tty.js';
import { DEFAULT_PANEL_POSITIONS, SETTINGS_PICKER_MAX_HEIGHT } from '../src/ui-contracts.js';
import { SettingsPicker, settingsPickerJumpByName } from '../src/components/settings-picker.js';
import type { SettingsPickerProps } from '../src/components/settings-picker.js';
import {
  buildVisibleSectionHeaders,
  deriveSettingsSectionFieldStarts,
  type SettingsPickerRowData,
} from '../src/components/settings-picker-row-list.js';

const ROWS = 24;
const COLS = 80;

function baseProps(over: Partial<SettingsPickerProps> = {}): SettingsPickerProps {
  return {
    field: 0,
    mode: 'off',
    delayMs: 0,
    titleAnimation: true,
    yolo: false,
    fleetChat: 'off',
    chime: false,
    confirmExit: true,
    nextPrediction: false,
    featureMcp: true,
    featurePlugins: true,
    featureMemory: true,
    featureSkills: true,
    featureModelsRegistry: true,
    tokenSavingTier: 'off',
    allowOutsideProjectRoot: true,
    contextAutoCompact: true,
    contextStrategy: 'hybrid',
    contextMode: 'balanced',
    maxConcurrent: 10,
    logLevel: 'info',
    auditLevel: 'standard',
    indexOnStart: true,
    multiDiffSummaryThreshold: 5,
    maxIterations: 500,
    autoProceedMaxIterations: 50,
    enhanceDelayMs: 60_000,
    enhanceEnabled: true,
    enhanceLanguage: 'original',
    thinkingWord: 'thinking',
    reasoningMode: 'auto',
    reasoningEffort: 'high',
    reasoningPreserve: false,
    cacheTtl: 'default',
    debugStream: false,
    statuslineMode: 'detailed',
    configScope: 'global',
    animationStyle: 'rainbow',
    breakerEnabled: false,
    breakerAutoKillResetMs: 60_000,
    showModelReasoning: true,
    showAgentSwarmPanel: 'bottom',
    showSageMemoryInject: false,
    sageMemoryInjectThreshold: 0.85,
    readSymbols: false,
    panelPositions: DEFAULT_PANEL_POSITIONS,
    filter: '',
    inputHeight: 3,
    ...over,
  } as SettingsPickerProps;
}

describe('settings picker overflow at 24×80', () => {
  it('frame never exceeds terminal rows when focused at top', async () => {
    const view = renderRealTty(React.createElement(SettingsPicker, baseProps({ field: 0 })), {
      columns: COLS,
      rows: ROWS,
    });
    await settle();
    const lines = view.lines();
    expect(lines.length).toBeLessThanOrEqual(ROWS);
    // Title must be visible — no clipping of the picker header.
    expect(view.lastFrame()).toContain('Settings');
    view.unmount();
  });

  it('frame never exceeds terminal rows when scrolled to the last field', async () => {
    const lastField = settingsPickerJumpByName('Agent swarm panel');
    expect(lastField).toBeDefined();
    const view = renderRealTty(
      React.createElement(SettingsPicker, baseProps({ field: lastField! })),
      { columns: COLS, rows: ROWS },
    );
    await settle();
    const lines = view.lines();
    expect(lines.length).toBeLessThanOrEqual(ROWS);
    // The last section header and focused field should be visible.
    expect(view.lastFrame()).toContain('Agent swarm panel');
    view.unmount();
  });

  it('does not duplicate the title or garble content across re-renders', async () => {
    // Simulate scrolling: focus moves from field 0 → mid → last → back.
    const view = renderRealTty(React.createElement(SettingsPicker, baseProps({ field: 0 })), {
      columns: COLS,
      rows: ROWS,
    });
    await settle();

    const midField = settingsPickerJumpByName('Max iterations');
    const lastField = settingsPickerJumpByName('Agent swarm panel');

    // Scroll to middle
    view.rerender(React.createElement(SettingsPicker, baseProps({ field: midField! })));
    await settle();
    expect(view.lines().length).toBeLessThanOrEqual(ROWS);

    // Scroll to end
    view.rerender(React.createElement(SettingsPicker, baseProps({ field: lastField! })));
    await settle();
    expect(view.lines().length).toBeLessThanOrEqual(ROWS);

    // Scroll back to top
    view.rerender(React.createElement(SettingsPicker, baseProps({ field: 0 })));
    await settle();
    const finalLines = view.lines();
    expect(finalLines.length).toBeLessThanOrEqual(ROWS);

    // Title appears exactly once (no duplication from stale frames).
    const titleCount = finalLines.filter((l) => l.includes('Settings')).length;
    expect(titleCount).toBe(1);

    view.unmount();
  });

  it('accounts for multi-line input height without overflow', async () => {
    // Input buffer grew to 5 rows — picker must shrink to fit.
    const view = renderRealTty(
      React.createElement(SettingsPicker, baseProps({ field: 0, inputHeight: 5 })),
      { columns: COLS, rows: ROWS },
    );
    await settle();
    const lines = view.lines();
    expect(lines.length).toBeLessThanOrEqual(ROWS);
    expect(view.lastFrame()).toContain('Settings');
    view.unmount();
  });

  it('never overflows at ultra-narrow terminal (60 cols × 24 rows)', async () => {
    // At 60 cols, detail text wraps to ~4 lines per field — the old
    // linesPerField=2 undercount caused overflow.
    const view = renderRealTty(React.createElement(SettingsPicker, baseProps({ field: 0 })), {
      columns: 60,
      rows: 24,
    });
    await settle();
    const lines = view.lines();
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(view.lastFrame()).toContain('Settings');
    view.unmount();
  });

  it('full bottom-region composition fits at 24×80 with StatusBar', async () => {
    // Mirrors AppView's actual bottom-region layout: Input placeholder +
    // SettingsPicker + StatusBar(4 rows), all inside
    // the root cap (height=termRows, overflowY=hidden, flex-end).
    // This is the real integration test — if the pickerHeight budget
    // doesn't account for the status chrome, the root cap clips the
    // picker title here even though the standalone test passes.
    const { Box, Text } = await import('../src/ink.js');
    const inputRows = 3;
    const statusRows = 4; // StatusBar detailed-mode worst case
    const historyRows = ROWS - inputRows - statusRows - 8; // picker gets the rest

    function BottomRegionComposition() {
      return (
        <Box flexDirection="column" height={ROWS} overflowY="hidden" justifyContent="flex-end">
          <Box flexDirection="column" flexShrink={0}>
            {/* History viewport — shrinks to give the bottom region space */}
            <Box
              flexDirection="column"
              height={Math.max(0, historyRows)}
              overflowY="hidden"
              flexShrink={0}
            >
              <Text>{'history placeholder'}</Text>
            </Box>
            {/* Bottom region: Input + SettingsPicker + StatusBar */}
            <Box flexDirection="column" flexShrink={0}>
              {/* Input placeholder (same height as real Input) */}
              <Box flexDirection="column" height={inputRows} flexShrink={0}>
                {Array.from({ length: inputRows }, (_, i) => (
                  <Text key={i}>{`input-${i}`}</Text>
                ))}
              </Box>
              {/* SettingsPicker — the component under test */}
              <SettingsPicker
                {...baseProps({
                  field: 0,
                  inputHeight: inputRows,
                  statuslineMode: 'detailed',
                })}
              />
              {/* StatusBar placeholder (4 rows in detailed mode) */}
              <Box flexDirection="column" flexShrink={0}>
                {Array.from({ length: statusRows }, (_, i) => (
                  <Text key={i}>{`status-${i}`}</Text>
                ))}
              </Box>
            </Box>
          </Box>
        </Box>
      );
    }

    const view = renderRealTty(React.createElement(BottomRegionComposition), {
      columns: COLS,
      rows: ROWS,
    });
    await settle();
    const lines = view.lines();
    // The root cap guarantees no frame exceeds termRows.
    expect(lines.length).toBeLessThanOrEqual(ROWS);
    // The picker title must survive — it's the topmost element of the
    // picker and the first thing clipped if the budget is wrong.
    expect(view.lastFrame()).toContain('Settings');
    view.unmount();
  });
});

describe('settings picker fills its box (no blank area above the bottom border)', () => {
  // Count blank rows between the last content line and the round border's
  // bottom edge (╰). The old worst-case VISIBLE_FIELDS budget
  // (linesPerField + 1 per field) under-filled the box by 8–12 rows on a
  // 40-row terminal; the exact-fit window leaves at most 1–2.
  function blankRowsAboveBorder(lines: string[]): number {
    let borderIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if ((lines[i] ?? '').includes('╰')) {
        borderIdx = i;
        break;
      }
    }
    if (borderIdx < 0) return Number.POSITIVE_INFINITY;
    for (let i = borderIdx - 1; i >= 0; i--) {
      const line = lines[i] ?? '';
      // A visually blank row inside the picker still contains its vertical
      // border glyphs. Count only text between those borders.
      const left = line.indexOf('│');
      const right = line.lastIndexOf('│');
      const content = left >= 0 && right > left ? line.slice(left + 1, right) : line;
      if (content.trim().length > 0) return borderIdx - i - 1;
    }
    return borderIdx;
  }

  it('caps a 40×80 terminal while filling the capped box', async () => {
    const view = renderRealTty(
      React.createElement(SettingsPicker, baseProps({ field: 0, statuslineMode: 'minimum' })),
      { columns: 80, rows: 40 },
    );
    await settle();
    const lines = view.lines();
    expect(lines).toHaveLength(SETTINGS_PICKER_MAX_HEIGHT);
    expect(blankRowsAboveBorder(lines)).toBeLessThanOrEqual(2);
    expect(view.lastFrame()).toContain('Plugins');
    view.unmount();
  });

  it('caps a wide 40×120 terminal while filling the capped box', async () => {
    const view = renderRealTty(
      React.createElement(SettingsPicker, baseProps({ field: 0, statuslineMode: 'minimum' })),
      { columns: 120, rows: 40 },
    );
    await settle();
    const lines = view.lines();
    expect(lines).toHaveLength(SETTINGS_PICKER_MAX_HEIGHT);
    expect(blankRowsAboveBorder(lines)).toBeLessThanOrEqual(2);
    expect(view.lastFrame()).toContain('Plugins');
    view.unmount();
  });

  it('keeps the focused field visible when scrolled into a mid-list section (40×80)', async () => {
    const view = renderRealTty(
      React.createElement(SettingsPicker, baseProps({ field: 20, statuslineMode: 'minimum' })),
      { columns: 80, rows: 40 },
    );
    await settle();
    const lines = view.lines();
    expect(lines.length).toBeLessThanOrEqual(40);
    // No overflow AND the list still fills the box when the window is
    // centered mid-list (windowStart > 0, so scroll-above also renders).
    expect(blankRowsAboveBorder(lines)).toBeLessThanOrEqual(2);
    expect(view.lastFrame()).toContain('Index on session start');
    view.unmount();
  });

  it('reserves three additional rows in detailed mode without overflowing', async () => {
    const minimum = renderRealTty(
      React.createElement(SettingsPicker, baseProps({ field: 0, statuslineMode: 'minimum' })),
      { columns: 80, rows: 24 },
    );
    await settle();
    const minimumLines = minimum.lines();
    minimum.unmount();

    const noColor = renderRealTty(
      React.createElement(SettingsPicker, baseProps({ field: 0, statuslineMode: 'no-color' })),
      { columns: 80, rows: 24 },
    );
    await settle();
    const noColorLines = noColor.lines();
    noColor.unmount();

    const detailed = renderRealTty(
      React.createElement(SettingsPicker, baseProps({ field: 0, statuslineMode: 'detailed' })),
      { columns: 80, rows: 24 },
    );
    await settle();
    const detailedLines = detailed.lines();
    detailed.unmount();

    const bottomBorderRow = (lines: string[]): number => {
      for (let i = lines.length - 1; i >= 0; i--) {
        if ((lines[i] ?? '').includes('╰')) return i;
      }
      return -1;
    };
    expect(bottomBorderRow(noColorLines)).toBe(bottomBorderRow(minimumLines));
    expect(bottomBorderRow(minimumLines) - bottomBorderRow(detailedLines)).toBe(3);
    expect(noColorLines.length).toBeLessThanOrEqual(40);
    expect(detailedLines.length).toBeLessThanOrEqual(40);
    expect(blankRowsAboveBorder(detailedLines)).toBeLessThanOrEqual(2);
  });
});

describe('settings picker section-header accounting contract', () => {
  it('keeps gap-derived starts and renderer headers aligned for the production layout', async () => {
    let layout:
      | { rows: readonly SettingsPickerRowData[]; fieldRowIndex: readonly number[] }
      | undefined;
    const view = renderRealTty(
      React.createElement(
        SettingsPicker,
        baseProps({
          onLayoutComputed: (computed) => {
            layout = computed;
          },
        }),
      ),
      { columns: 80, rows: 40 },
    );
    await settle();
    view.unmount();

    expect(layout).toBeDefined();
    if (!layout) throw new Error('SettingsPicker did not publish its production layout');
    const { rows, fieldRowIndex } = layout;

    // Independently derive the expected field start of every section by
    // walking the production rows, not by repeating the gap algorithm.
    const expectedStarts: number[] = [];
    const headerRows: number[] = [];
    let fieldCount = 0;
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      if (rows[rowIdx]?.section) {
        expectedStarts.push(fieldCount);
        headerRows.push(rowIdx);
      } else {
        fieldCount++;
      }
    }
    expect(fieldCount).toBe(fieldRowIndex.length);
    expect(deriveSettingsSectionFieldStarts(fieldRowIndex)).toEqual(expectedStarts);

    // Exercise windows immediately before, at, and after every real section
    // boundary. These are the points where budget/header desync can occur.
    const windows = new Set<string>();
    for (const boundary of [...expectedStarts, fieldRowIndex.length]) {
      for (const start of [boundary - 1, boundary]) {
        for (const end of [boundary, boundary + 1]) {
          const clampedStart = Math.max(0, Math.min(start, fieldRowIndex.length - 1));
          const clampedEnd = Math.max(clampedStart + 1, Math.min(end, fieldRowIndex.length));
          windows.add(`${clampedStart}:${clampedEnd}`);
        }
      }
    }

    for (const window of windows) {
      const [startText, endText] = window.split(':');
      const start = Number(startText);
      const end = Number(endText);
      const expectedHeaders = new Set(
        expectedStarts.flatMap((sectionStart, index) => {
          const sectionEnd = expectedStarts[index + 1] ?? fieldRowIndex.length;
          return sectionStart < end && sectionEnd > start ? [headerRows[index] ?? -1] : [];
        }),
      );
      expect(buildVisibleSectionHeaders(rows, fieldRowIndex, start, end)).toEqual(expectedHeaders);
    }
  });
});
