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

/**
 * RAM guard for the Myers trace, which keeps one `(2·(N+M)+1)`-entry snapshot
 * per edit step: O(D·(N+M)) bytes. A mostly rewritten file has D ≈ N+M, and a
 * 6000-line rewrite took ~1 GB to print "delete all, insert all". Past the
 * guard the diff is still complete and valid — see {@link replaceMiddle}.
 */
const MAX_TRACE_BYTES = 64 * 1024 * 1024;

/**
 * Edit script that keeps the common prefix/suffix and replaces the middle
 * wholesale. Every change is still in it; it is only not guaranteed minimal.
 */
function replaceMiddle(a: string[], b: string[]): Edit[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < pre; i++) edits.push({ op: 'equal', a: i, b: i, line: a[i] ?? '' });
  for (let i = pre; i < a.length - suf; i++) {
    edits.push({ op: 'delete', a: i, b: pre, line: a[i] ?? '' });
  }
  for (let j = pre; j < b.length - suf; j++) {
    edits.push({ op: 'insert', a: a.length - suf, b: j, line: b[j] ?? '' });
  }
  for (let s = suf; s > 0; s--) {
    edits.push({ op: 'equal', a: a.length - s, b: b.length - s, line: a[a.length - s] ?? '' });
  }
  return edits;
}

function myersDiff(a: string[], b: string[]): Edit[] {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  if (max === 0) return [];

  const offset = max;
  const v = new Int32Array(2 * max + 1).fill(-1);
  v[1 + offset] = 0;
  const trace: Int32Array[] = [];
  const snapshotBytes = v.byteLength;

  for (let d = 0; d <= max; d++) {
    if ((d + 1) * snapshotBytes > MAX_TRACE_BYTES) return replaceMiddle(a, b);
    trace.push(new Int32Array(v));
    for (let k = -d; k <= d; k += 2) {
      const left = v[k - 1 + offset] ?? -1;
      const right = v[k + 1 + offset] ?? -1;
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
      v[k + offset] = x;
      if (x >= N && y >= M) {
        return backtrack(trace, a, b, N, M, d, offset);
      }
    }
  }
  return [];
}

function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  N: number,
  M: number,
  finalD: number,
  offset: number,
): Edit[] {
  const edits: Edit[] = [];
  let x = N;
  let y = M;
  for (let d = finalD; d > 0; d--) {
    const v = trace[d];
    if (!v) break;
    const k = x - y;
    const left = v[k - 1 + offset] ?? -1;
    const right = v[k + 1 + offset] ?? -1;
    let prevK: number;
    if (k === -d || (k !== d && left < right)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[prevK + offset] ?? 0;
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

/**
 * A last line without a trailing newline is a different line from the same
 * text with one — otherwise dropping or adding the final newline diffs as
 * "no change". The marker is internal; {@link showLine} renders it as the
 * standard `\ No newline at end of file` line.
 */
const NO_EOL = '\u0000no-eol';

function markNoEol(lines: string[]): void {
  const last = lines.length - 1;
  if (last >= 0) lines[last] = `${lines[last]}${NO_EOL}`;
}

function showLine(line: string): string {
  return line.endsWith(NO_EOL)
    ? `${line.slice(0, -NO_EOL.length)}\n\\ No newline at end of file`
    : line;
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
  if (typeof oldText !== 'string' || typeof newText !== 'string') return '';
  const context =
    typeof opts.context === 'number' && Number.isFinite(opts.context)
      ? Math.max(0, Math.floor(opts.context))
      : 3;
  const a = oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText.replace(/\r\n/g, '\n').split('\n');
  // Handle trailing newline: split adds an empty string we don't want to diff
  if (a[a.length - 1] === '') a.pop();
  else markNoEol(a);
  if (b[b.length - 1] === '') b.pop();
  else markNoEol(b);
  const edits = myersDiff(a, b);
  if (edits.every((e) => e.op === 'equal')) return '';

  const hunks: {
    aStart: number;
    aCount: number;
    bStart: number;
    bCount: number;
    lines: string[];
  }[] = [];
  let i = 0;
  while (i < edits.length) {
    while (i < edits.length && edits[i]?.op === 'equal') i++;
    if (i >= edits.length) break;
    const hunkStart = Math.max(0, i - context);
    const lines: string[] = [];
    let firstA: number | null = null;
    let firstB: number | null = null;
    let aCount = 0;
    let bCount = 0;
    let cursor = hunkStart;
    let trailing = 0;
    while (cursor < edits.length) {
      const e = edits[cursor];
      if (!e) break;
      if (e.op === 'equal') {
        // `trailing` counts equal lines actually pushed. Counting the line
        // that ends the hunk too made the trim below drop one real context
        // line, so a hunk followed by a long equal run kept `context - 1`.
        if (trailing >= context * 2) break;
        trailing++;
      } else {
        trailing = 0;
      }
      if (e.op === 'equal') {
        if (firstA === null) firstA = e.a + 1;
        if (firstB === null) firstB = e.b + 1;
        lines.push(` ${showLine(e.line)}`);
        aCount++;
        bCount++;
      } else if (e.op === 'delete') {
        if (firstA === null) firstA = e.a + 1;
        lines.push(`-${showLine(e.line)}`);
        aCount++;
      } else {
        if (firstB === null) firstB = e.b + 1;
        lines.push(`+${showLine(e.line)}`);
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
    const aStart = aCount === 0 ? (edits[hunkStart]?.a ?? 0) : (firstA ?? 1);
    const bStart = bCount === 0 ? (edits[hunkStart]?.b ?? 0) : (firstB ?? 1);
    hunks.push({ aStart, aCount, bStart, bCount, lines });
    i = cursor;
  }
  if (hunks.length === 0) return '';

  let out = '';
  out += `--- ${opts.fromFile ?? 'a'}\n`;
  out += `+++ ${opts.toFile ?? 'b'}\n`;
  for (const h of hunks) {
    out += `@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@\n`;
    out += `${h.lines.join('\n')}\n`;
  }
  return out;
}
