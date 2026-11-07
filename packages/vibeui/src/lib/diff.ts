export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Bounded look-ahead produces a valid line edit script without quadratic memory. */
export function compareLines(before: string, after: string): DiffLine[] {
  const oldLines = before ? before.replace(/\r\n?/g, '\n').split('\n') : [];
  const newLines = after ? after.replace(/\r\n?/g, '\n').split('\n') : [];
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push({ kind: 'context', text: oldLines[i]!, oldLine: ++i, newLine: ++j });
      continue;
    }
    let addCount = -1;
    let removeCount = -1;
    for (let step = 1; step <= 48; step++) {
      if (
        addCount < 0 &&
        i < oldLines.length &&
        j + step < newLines.length &&
        oldLines[i] === newLines[j + step]
      )
        addCount = step;
      if (
        removeCount < 0 &&
        j < newLines.length &&
        i + step < oldLines.length &&
        oldLines[i + step] === newLines[j]
      )
        removeCount = step;
    }
    if (addCount >= 0 && (removeCount < 0 || addCount <= removeCount)) {
      for (let n = 0; n < addCount; n++)
        lines.push({ kind: 'add', text: newLines[j]!, oldLine: null, newLine: ++j });
    } else if (removeCount >= 0) {
      for (let n = 0; n < removeCount; n++)
        lines.push({ kind: 'remove', text: oldLines[i]!, oldLine: ++i, newLine: null });
    } else {
      if (i < oldLines.length)
        lines.push({ kind: 'remove', text: oldLines[i]!, oldLine: ++i, newLine: null });
      if (j < newLines.length)
        lines.push({ kind: 'add', text: newLines[j]!, oldLine: null, newLine: ++j });
    }
  }
  return lines;
}
