import { lineDiff } from './file-model';

export type MergeChoice = 'mine' | 'stored' | 'both';
export type MergeSegment =
  | { kind: 'same'; lines: string[] }
  | { kind: 'change'; id: number; mine: string[]; stored: string[] };

/** The two drafts as shared lines and numbered changes between them. */
export function mergeSegments(mine: string, stored: string): MergeSegment[] {
  const segments: MergeSegment[] = [];
  let id = 0;
  for (const line of lineDiff(mine, stored)) {
    const last = segments[segments.length - 1];
    if (line.kind === 'same') {
      if (last?.kind === 'same') last.lines.push(line.text);
      else segments.push({ kind: 'same', lines: [line.text] });
      continue;
    }
    const change =
      last?.kind === 'change' ? last : { kind: 'change' as const, id: id++, mine: [], stored: [] };
    if (change !== last) segments.push(change);
    (line.kind === 'remove' ? change.mine : change.stored).push(line.text);
  }
  return segments;
}

/** The merged draft; a change without a choice keeps your editor's lines. */
export function mergedText(
  segments: readonly MergeSegment[],
  choices: Readonly<Record<number, MergeChoice>>,
): string {
  const lines: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'same') lines.push(...segment.lines);
    else {
      const choice = choices[segment.id] ?? 'mine';
      if (choice !== 'stored') lines.push(...segment.mine);
      if (choice !== 'mine') lines.push(...segment.stored);
    }
  }
  return lines.join('\n');
}
