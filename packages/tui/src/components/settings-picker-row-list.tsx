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
    <Text key={`row-${row.label ?? fieldIdx}`} inverse={selected} {...(selected ? { color: 'yellow' } : {})}>
      {selected ? '› ' : '  '}
      {filterActive ? (
        <>
          {segments.map((seg, j) => (
            <Text key={j} bold {...(seg.match ? { color: 'yellow' } : { dimColor: true })}>
              {seg.text}
            </Text>
          ))}
          <Text bold dimColor>{' '.repeat(padNeeded)}</Text>
        </>
      ) : (
        <Text bold>{labelStr.padEnd(26)}</Text>
      )}
      <Text color="cyan">{String(row.value ?? '').padEnd(12)}</Text>
      <Text dimColor>{row.detail ?? ''}</Text>
    </Text>
  );
}

function buildVisibleSectionHeaders(
  rows: readonly SettingsPickerRowData[],
  fieldRowIndex: readonly number[],
  windowStart: number,
  windowEnd: number,
): Set<number> {
  const sectionFields: Array<{ headerIdx: number; fieldStart: number; fieldEnd: number }> = [];
  let curHeader = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.section) curHeader = i;
    else if (curHeader >= 0) {
      const fieldIdx = fieldRowIndex.indexOf(i);
      if (fieldIdx === -1) continue;
      const entry = sectionFields.find((s) => s.headerIdx === curHeader);
      if (entry) {
        entry.fieldEnd = fieldIdx + 1;
      } else {
        sectionFields.push({ headerIdx: curHeader, fieldStart: fieldIdx, fieldEnd: fieldIdx + 1 });
      }
    }
  }
  return new Set(
    sectionFields
      .filter((section) => section.fieldStart < windowEnd && section.fieldEnd > windowStart)
      .map((section) => section.headerIdx),
  );
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
}: SettingsPickerRowListProps): React.ReactElement {
  if (filterActive) {
    return (
      <>
        {rankedResults.map((result) => {
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
