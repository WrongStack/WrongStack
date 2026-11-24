export function truncateDiffSurrogateSafe(
  text: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return {
    text: `${text.slice(0, end)}\n... (diff truncated at ${maxChars} bytes — please use the read tool to view full file content)`,
    truncated: true,
  };
}

const SYMBOL_PATTERNS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)/,
];

export function extractSymbolName(codeLine: string): string | null {
  for (const pattern of SYMBOL_PATTERNS) {
    const match = pattern.exec(codeLine);
    if (match?.[1]) return match[1];
  }
  return null;
}

const EXPORTED_SYMBOL_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/,
];

function extractExportedSymbolName(codeLine: string): string | null {
  for (const pattern of EXPORTED_SYMBOL_PATTERNS) {
    const match = pattern.exec(codeLine);
    if (match?.[1]) return match[1];
  }
  return null;
}

export interface AnnotatedDiffResult {
  annotatedDiff: string;
  hunkCount: number;
  addedLines: number;
  removedLines: number;
  changedSymbols: string[];
  modifiedExportedSymbols: string[];
}

export const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Annotate a unified diff with exact post-image (current disk) line numbers on
 * `+` and context lines so the reviewer can cite `file:line` directly without
 * issuing redundant `read` tool calls. Also extracts hunk/line counts and
 * touched top-level symbol names.
 */
export function annotateUnifiedDiffWithLineNumbers(rawDiff: string): AnnotatedDiffResult {
  const lines = rawDiff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  let inHunk = false;
  let seenChangeInHunk = false;
  let newLine = 0;
  // Body lines the current hunk header still promises. While any remain, a line
  // is hunk content even when it reads like a header: a removed `-- note` line
  // (SQL/Lua) arrives as `--- note`, an added `++ x` line as `+++ x`.
  let oldLeft = 0;
  let newLeft = 0;
  let hunkCount = 0;
  let addedLines = 0;
  let removedLines = 0;
  const symbols = new Set<string>();
  const modifiedExports = new Set<string>();

  for (const line of lines) {
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      inHunk = true;
      seenChangeInHunk = false;
      hunkCount++;
      newLine = Number.parseInt(hunkMatch[3]!, 10);
      oldLeft = hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10);
      newLeft = hunkMatch[4] === undefined ? 1 : Number.parseInt(hunkMatch[4], 10);
      const headerContext = hunkMatch[5]?.trim();
      if (headerContext) {
        const sym = extractSymbolName(headerContext);
        if (sym && symbols.size < 16) symbols.add(sym);
      }
      out.push(line);
      continue;
    }

    if (
      !(inHunk && (oldLeft > 0 || newLeft > 0)) &&
      (line.startsWith('diff --git ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('new file mode ') ||
        line.startsWith('deleted file mode ') ||
        line.startsWith('similarity index ') ||
        line.startsWith('rename from ') ||
        line.startsWith('rename to '))
    ) {
      inHunk = false;
      seenChangeInHunk = false;
      out.push(line);
      continue;
    }

    if (!inHunk) {
      out.push(line);
      continue;
    }

    if (line.startsWith('+')) {
      seenChangeInHunk = true;
      const body = line.slice(1);
      out.push(`${String(newLine).padStart(4, ' ')} | +${body}`);
      newLine++;
      newLeft--;
      addedLines++;
      const sym = extractSymbolName(body);
      if (sym && symbols.size < 16) symbols.add(sym);
      const exportedSym = extractExportedSymbolName(body);
      if (exportedSym && modifiedExports.size < 8) modifiedExports.add(exportedSym);
    } else if (line.startsWith('-')) {
      seenChangeInHunk = true;
      const body = line.slice(1);
      out.push(`     | -${body}`);
      oldLeft--;
      removedLines++;
      const sym = extractSymbolName(body);
      if (sym && symbols.size < 16) symbols.add(sym);
      const exportedSym = extractExportedSymbolName(body);
      if (exportedSym && modifiedExports.size < 8) modifiedExports.add(exportedSym);
    } else if (line.startsWith(' ')) {
      const body = line.slice(1);
      out.push(`${String(newLine).padStart(4, ' ')} |  ${body}`);
      newLine++;
      oldLeft--;
      newLeft--;
      // When a hunk starts near the top of a declaration, git diff places the
      // signature in the leading context lines rather than the `@@` header.
      if (!seenChangeInHunk) {
        const sym = extractSymbolName(body);
        if (sym && symbols.size < 16) symbols.add(sym);
      }
    } else {
      out.push(line);
    }
  }

  return {
    annotatedDiff: out.join('\n'),
    hunkCount,
    addedLines,
    removedLines,
    changedSymbols: [...symbols],
    modifiedExportedSymbols: [...modifiedExports],
  };
}

/**
 * Compute a compact line-numbered unified delta diff between `previousContent`
 * (an earlier completed review snapshot in this session) and `currentContent`
 * (current file on disk), with 3 lines of context and exact current disk line
 * numbers. Falls back to `null` if inputs are huge (>6,000 lines) or identical.
 */
export function computeHybridIncrementalDeltaDiff(
  previousContent: string,
  currentContent: string,
  headStats?: { hunkCount: number; addedLines: number; removedLines: number } | undefined,
): (AnnotatedDiffResult & { unchangedHunkSummary?: string | undefined }) | null {
  if (previousContent === currentContent) return null;
  const oldLines = previousContent.replace(/\r\n/g, '\n').split('\n');
  const newLines = currentContent.replace(/\r\n/g, '\n').split('\n');
  if (oldLines.length > 6_000 || newLines.length > 6_000) return null;

  // Trim common prefix and suffix first so typical localized edits run in O(delta^2)
  // rather than O(N*M) across the whole file.
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const midOld = oldLines.slice(prefix, oldEnd);
  const midNew = newLines.slice(prefix, newEnd);
  if (midOld.length * midNew.length > 1_500_000) return null;

  // LCS over the changed middle window
  const m = midOld.length;
  const n = midNew.length;
  const dp = new Uint16Array((m + 1) * (n + 1));
  const stride = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (midOld[i] === midNew[j]) {
        dp[i * stride + j] = (dp[(i + 1) * stride + (j + 1)] ?? 0) + 1;
      } else {
        const down = dp[(i + 1) * stride + j] ?? 0;
        const right = dp[i * stride + (j + 1)] ?? 0;
        dp[i * stride + j] = Math.max(down, right);
      }
    }
  }

  type EditOp = { kind: 'equal' | 'add' | 'del'; text: string; oldLine: number; newLine: number };
  const ops: EditOp[] = [];
  for (let k = 0; k < prefix; k++) {
    ops.push({ kind: 'equal', text: newLines[k]!, oldLine: k + 1, newLine: k + 1 });
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (midOld[i] === midNew[j]) {
      ops.push({
        kind: 'equal',
        text: midNew[j]!,
        oldLine: prefix + i + 1,
        newLine: prefix + j + 1,
      });
      i++;
      j++;
    } else if ((dp[(i + 1) * stride + j] ?? 0) >= (dp[i * stride + (j + 1)] ?? 0)) {
      ops.push({
        kind: 'del',
        text: midOld[i]!,
        oldLine: prefix + i + 1,
        newLine: prefix + j + 1,
      });
      i++;
    } else {
      ops.push({
        kind: 'add',
        text: midNew[j]!,
        oldLine: prefix + i + 1,
        newLine: prefix + j + 1,
      });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: 'del', text: midOld[i]!, oldLine: prefix + i + 1, newLine: prefix + n + 1 });
    i++;
  }
  while (j < n) {
    ops.push({ kind: 'add', text: midNew[j]!, oldLine: prefix + m + 1, newLine: prefix + j + 1 });
    j++;
  }
  for (let k = newEnd; k < newLines.length; k++) {
    const oldIdx = oldEnd + (k - newEnd);
    ops.push({ kind: 'equal', text: newLines[k]!, oldLine: oldIdx + 1, newLine: k + 1 });
  }

  // Group non-equal ops into unified hunks with 3 lines of context
  const CONTEXT = 3;
  const changedIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx]!.kind !== 'equal') changedIndices.push(idx);
  }
  if (changedIndices.length === 0) return null;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(ops.length - 1, idx + CONTEXT);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const rawHunks: string[] = [];
  for (const range of ranges) {
    const slice = ops.slice(range.start, range.end + 1);
    const oldStart = slice[0]!.oldLine;
    const newStart = slice[0]!.newLine;
    const oldCount = slice.filter((op) => op.kind !== 'add').length;
    const newCount = slice.filter((op) => op.kind !== 'del').length;
    rawHunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      if (op.kind === 'add') rawHunks.push(`+${op.text}`);
      else if (op.kind === 'del') rawHunks.push(`-${op.text}`);
      else rawHunks.push(` ${op.text}`);
    }
  }

  const annotated = annotateUnifiedDiffWithLineNumbers(rawHunks.join('\n'));
  const unchangedHunkSummary =
    headStats && headStats.hunkCount > annotated.hunkCount
      ? `${headStats.hunkCount - annotated.hunkCount} earlier session hunk(s) against HEAD were already reviewed and remain unchanged.`
      : 'Showing only delta edits since the previous completed review snapshot in this session.';
  return {
    ...annotated,
    unchangedHunkSummary,
  };
}
