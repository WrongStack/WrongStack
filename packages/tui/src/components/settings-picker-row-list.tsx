import { Text } from '../ink.js';
import type React from 'react';
import type { SettingsFilterResult, SettingsHighlightSegment } from './settings-picker-filter.js';

export interface SettingsPickerRowData {
  section?: string | undefined;
  label?: string | undefined;
  value?: string | undefined;
  detail?: string | undefined;
}

interface SettingsPickerRowListProps {
  rows: readonly SettingsPickerRowData[];
  field: number;
  fieldRowIndex: readonly number[];
  filterActive: boolean;
  rankedResults: readonly SettingsFilterResult[];
  highlightSegments: (label: string) => readonly SettingsHighlightSegment[];
  windowStart: number;
  windowEnd: number;
  filterWindowStart: number;
  filterWindowEnd: number;
}

function renderPickerRow(
  row: SettingsPickerRowData,
  fieldIdx: number,
  selected: boolean,
  filterActive: boolean,
  highlightSegments: (label: string) => readonly SettingsHighlightSegment[],
): React.ReactElement {
  const labelStr = row.label ?? '';
  const segments = highlightSegments(labelStr);
  const padNeeded = Math.max(0, 26 - labelStr.length);
  return (
    <Text key={`row-${fieldIdx}`} inverse={selected} {...(selected ? { color: 'yellow' } : {})}>
      {selected ? '› ' : '  '}
      {filterActive ? (
        <>
          {segments.map((seg, j) => (
            <Text key={j} bold {...(seg.match ? { color: 'yellow' } : { dimColor: true })}>
              {seg.text}
            </Text>
          ))}
          <Text bold dimColor>
            {' '.repeat(padNeeded)}
          </Text>
        </>
      ) : (
        <Text bold>{labelStr.padEnd(26)}</Text>
      )}
      <Text color="cyan">{String(row.value ?? '').padEnd(12)}</Text>
      <Text dimColor>{row.detail ?? ''}</Text>
    </Text>
  );
}

export function deriveSettingsSectionFieldStarts(
  fieldRowIndex: readonly number[],
): readonly number[] {
  const starts: number[] = [];
  for (let fieldIdx = 0; fieldIdx < fieldRowIndex.length; fieldIdx++) {
    const rowIdx = fieldRowIndex[fieldIdx] ?? 0;
    const previousRowIdx = fieldIdx > 0 ? (fieldRowIndex[fieldIdx - 1] ?? 0) : -1;
    if (fieldIdx === 0 || rowIdx - previousRowIdx > 1) starts.push(fieldIdx);
  }
  return starts;
}

export function buildVisibleSectionHeaders(
  rows: readonly SettingsPickerRowData[],
  fieldRowIndex: readonly number[],
  windowStart: number,
  windowEnd: number,
): Set<number> {
  const sectionStarts = deriveSettingsSectionFieldStarts(fieldRowIndex);
  const visibleHeaders = new Set<number>();

  for (let i = 0; i < sectionStarts.length; i++) {
    const fieldStart = sectionStarts[i] ?? 0;
    const fieldEnd = sectionStarts[i + 1] ?? fieldRowIndex.length;
    if (fieldStart >= windowEnd || fieldEnd <= windowStart) continue;

    const firstFieldRow = fieldRowIndex[fieldStart];
    if (firstFieldRow === undefined) continue;
    const headerIdx = firstFieldRow - 1;
    if (rows[headerIdx]?.section) visibleHeaders.add(headerIdx);
  }

  return visibleHeaders;
}

export function SettingsPickerRowList({
  rows,
  field,
  fieldRowIndex,
  filterActive,
  rankedResults,
  highlightSegments,
  windowStart,
  windowEnd,
  filterWindowStart,
  filterWindowEnd,
}: SettingsPickerRowListProps): React.ReactElement {
  if (filterActive) {
    return (
      <>
        {rankedResults.slice(filterWindowStart, filterWindowEnd).map((result) => {
          const fieldIdx = result.chord.field;
          const rowIdx = fieldRowIndex[fieldIdx] ?? -1;
          const row = rows[rowIdx];
          if (!row?.label) return null;
          return renderPickerRow(row, fieldIdx, fieldIdx === field, true, highlightSegments);
        })}
      </>
    );
  }

  const visibleSections = buildVisibleSectionHeaders(rows, fieldRowIndex, windowStart, windowEnd);
  return (
    <>
      {rows.map((row, i) => {
        const fieldAtRow = fieldRowIndex.indexOf(i);
        if (fieldAtRow === -1) {
          if (!visibleSections.has(i)) return null;
          return (
            <Text key={`section-${row.section ?? i}`} bold color="green">
              ── {row.section} ──
            </Text>
          );
        }
        if (fieldAtRow < windowStart || fieldAtRow >= windowEnd) return null;
        return renderPickerRow(row, fieldAtRow, fieldAtRow === field, false, highlightSegments);
      })}
    </>
  );
}
