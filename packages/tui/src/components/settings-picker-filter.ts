import type { SettingsPickerJumpChord } from './settings-picker-jumps.js';

export type SettingsHighlightSegment = { text: string; match: boolean };

export type SettingsFilterResult = {
  chord: SettingsPickerJumpChord;
  contiguous: boolean;
  fuzzyIdx: number[] | undefined;
  score: number;
};

interface SettingsFilterState {
  filterActive: boolean;
  filterQuery: string;
  rankedResults: SettingsFilterResult[];
  filteredFieldIndices: number[];
  highlightSegments: (label: string) => SettingsHighlightSegment[];
}

function fuzzyMatch(haystack: string, needle: string): number[] | undefined {
  const lower = haystack.toLowerCase();
  const indices: number[] = [];
  let ni = 0;
  for (let hi = 0; hi < lower.length && ni < needle.length; hi++) {
    if (lower[hi] === needle[ni]) {
      indices.push(hi);
      ni++;
    }
  }
  return ni === needle.length ? indices : undefined;
}

function scoreMatch(
  contiguous: boolean,
  matchIndices: number[] | undefined,
  labelLength: number,
): number {
  const tier = contiguous ? 0 : 1000;
  if (!matchIndices || matchIndices.length === 0) return tier;
  const firstPos = matchIndices[0] ?? 0;
  const span = (matchIndices.at(-1) ?? 0) - firstPos;
  const gap = span - (matchIndices.length - 1);
  const lengthPenalty = Math.max(0, labelLength - 8);
  return tier + firstPos + gap * 2 + lengthPenalty;
}

function highlightLabel(
  label: string,
  filterActive: boolean,
  filterQuery: string,
  fuzzyResults: readonly SettingsFilterResult[],
): SettingsHighlightSegment[] {
  if (!filterActive || !filterQuery) return [{ text: label, match: false }];

  const result = fuzzyResults.find((r) => r.chord.label === label);
  if (!result) return [{ text: label, match: false }];

  if (result.contiguous) {
    const lower = label.toLowerCase();
    const segments: SettingsHighlightSegment[] = [];
    let cursor = 0;
    while (cursor < label.length) {
      const idx = lower.indexOf(filterQuery, cursor);
      if (idx === -1) {
        segments.push({ text: label.slice(cursor), match: false });
        break;
      }
      if (idx > cursor) segments.push({ text: label.slice(cursor, idx), match: false });
      segments.push({ text: label.slice(idx, idx + filterQuery.length), match: true });
      cursor = idx + filterQuery.length;
    }
    return segments;
  }

  if (result.fuzzyIdx) {
    const matchSet = new Set(result.fuzzyIdx);
    const segments: SettingsHighlightSegment[] = [];
    let current = '';
    let currentMatch = false;
    for (let i = 0; i < label.length; i++) {
      const isMatch = matchSet.has(i);
      if (i === 0) {
        current = label[i] ?? '';
        currentMatch = isMatch;
      } else if (isMatch === currentMatch) {
        current += label[i] ?? '';
      } else {
        segments.push({ text: current, match: currentMatch });
        current = label[i] ?? '';
        currentMatch = isMatch;
      }
    }
    if (current) segments.push({ text: current, match: currentMatch });
    return segments;
  }

  return [{ text: label, match: false }];
}

export function buildSettingsFilterState(
  filter: string | undefined,
  chords: readonly SettingsPickerJumpChord[],
): SettingsFilterState {
  const filterActive = Boolean(filter && filter.length > 1);
  const filterQuery = filter && filter.length > 1 ? filter.slice(1).toLowerCase() : '';
  const fuzzyResults: SettingsFilterResult[] = filterActive
    ? chords.map((chord) => {
        const label = chord.label;
        const contiguous = label.toLowerCase().includes(filterQuery);
        if (contiguous) {
          const firstIdx = label.toLowerCase().indexOf(filterQuery);
          const indices = Array.from({ length: filterQuery.length }, (_, i) => firstIdx + i);
          return {
            chord,
            contiguous,
            fuzzyIdx: undefined,
            score: scoreMatch(true, indices, label.length),
          };
        }
        const fuzzyIdx = fuzzyMatch(label, filterQuery);
        return {
          chord,
          contiguous: false,
          fuzzyIdx,
          score: fuzzyIdx !== undefined ? scoreMatch(false, fuzzyIdx, label.length) : Infinity,
        };
      })
    : [];

  const rankedResults = fuzzyResults
    .filter((result) => result.contiguous || result.fuzzyIdx !== undefined)
    .sort((a, b) => a.score - b.score);

  return {
    filterActive,
    filterQuery,
    rankedResults,
    filteredFieldIndices: rankedResults.map((result) => result.chord.field),
    highlightSegments: (label) => highlightLabel(label, filterActive, filterQuery, fuzzyResults),
  };
}
