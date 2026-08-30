/**
 * Myers diff with unified-format output. No external dependencies.
 * Operates on arrays of lines (newline-terminated or stripped).
 */

interface Edit {
  op: 'equal' | 'insert' | 'delete';
  a: number;
  b: number;
  line: string;
}

function myersDiff(a: string[], b: string[]): Edit[] {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  if (max === 0) return [];

  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];

  for (let d = 0; d <= max; d++) {
    const snapshot = new Map(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      const left = v.get(k - 1) ?? -1;
      const right = v.get(k + 1) ?? -1;
      let x: number;
      if (k === -d || (k !== d && left < right)) {
        x = right;
      } else {
        x = left + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= N && y >= M) {
        return backtrack(trace, a, b, N, M, d);
      }
    }
  }
  return [];
}

function backtrack(
  trace: Map<number, number>[],
  a: string[],
  b: string[],
  N: number,
  M: number,
  finalD: number,
): Edit[] {
  const edits: Edit[] = [];
  let x = N;
  let y = M;
  for (let d = finalD; d > 0; d--) {
    const v = trace[d];
    if (!v) break;
    const k = x - y;
    const left = v.get(k - 1) ?? -1;
    const right = v.get(k + 1) ?? -1;
    let prevK: number;
    if (k === -d || (k !== d && left < right)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: 'equal', a: x - 1, b: y - 1, line: a[x - 1] ?? '' });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        edits.push({ op: 'insert', a: x, b: y - 1, line: b[y - 1] ?? '' });
      } else {
        edits.push({ op: 'delete', a: x - 1, b: y, line: a[x - 1] ?? '' });
      }
      x = prevX;
      y = prevY;
    }
  }
  while (x > 0 && y > 0) {
    edits.push({ op: 'equal', a: x - 1, b: y - 1, line: a[x - 1] ?? '' });
    x--;
    y--;
  }
  return edits.reverse();
}

export interface UnifiedDiffOptions {
  context?: number | undefined;
  fromFile?: string | undefined;
  toFile?: string | undefined;
}

export function unifiedDiff(
  oldText: string,
  newText: string,
  opts: UnifiedDiffOptions = {},
): string {
  const context = opts.context ?? 3;
  const a = oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText.replace(/\r\n/g, '\n').split('\n');
  // Handle trailing newline: split adds an empty string we don't want to diff
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  const edits = myersDiff(a, b);
  if (edits.every((e) => e.op === 'equal')) return '';

  const hunks: { aStart: number; bStart: number; lines: string[] }[] = [];
  let i = 0;
  while (i < edits.length) {
    while (i < edits.length && edits[i]?.op === 'equal') i++;
    if (i >= edits.length) break;
    const hunkStart = Math.max(0, i - context);
    const lines: string[] = [];
    let aStart = (edits[hunkStart]?.a ?? 0) + 1;
    let bStart = (edits[hunkStart]?.b ?? 0) + 1;
    let aCount = 0;
    let bCount = 0;
    let cursor = hunkStart;
    let trailing = 0;
    while (cursor < edits.length) {
      const e = edits[cursor];
      if (!e) break;
      if (e.op === 'equal') {
        trailing++;
        if (trailing > context * 2) break;
      } else {
        trailing = 0;
      }
      if (e.op === 'equal') {
        lines.push(` ${e.line}`);
        aCount++;
        bCount++;
      } else if (e.op === 'delete') {
        lines.push(`-${e.line}`);
        aCount++;
      } else {
        lines.push(`+${e.line}`);
        bCount++;
      }
      cursor++;
    }
    // Trim trailing context lines beyond `context`
    while (lines.length > 0 && lines[lines.length - 1]?.startsWith(' ') && trailing > context) {
      lines.pop();
      aCount--;
      bCount--;
      trailing--;
    }
    if (aCount === 0) aStart = 0;
    if (bCount === 0) bStart = 0;
    hunks.push({ aStart, bStart, lines });
    i = cursor;
  }
  if (hunks.length === 0) return '';

  let out = '';
  out += `--- ${opts.fromFile ?? 'a'}\n`;
  out += `+++ ${opts.toFile ?? 'b'}\n`;
  for (const h of hunks) {
    let aCount = 0;
    let bCount = 0;
    for (const l of h.lines) {
      if (l.startsWith(' ')) {
        aCount++;
        bCount++;
      } else if (l.startsWith('-')) aCount++;
      else if (l.startsWith('+')) bCount++;
    }
    out += `@@ -${h.aStart},${aCount} +${h.bStart},${bCount} @@\n`;
    out += `${h.lines.join('\n')}\n`;
  }
  return out;
}
