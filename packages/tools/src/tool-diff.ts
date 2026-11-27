// Tool-output diff model — the single source of truth for turning an
// edit/write/patch tool call into a red/green diff, shared by the WebUI
// (DiffView) and the HQ dashboard chat-history sidebar.
//
// PURE + browser-safe (no node imports). Two consumption modes, mirroring the
// pattern in ./tool-summary:
//   1. WebUI/TS: import { diffFromToolInput, computeLineDiff } directly.
//   2. HQ: it is a served template-literal string that cannot `import`, so it
//      embeds the *_BROWSER_SRC transcriptions and a parity test guarantees the
//      two never drift.
//
// Three tool families produce three diff shapes:
//   - edit / str_replace  -> { mode:'lcs', oldText, newText }  (LCS line diff)
//   - write / create      -> { mode:'lcs', oldText:'', newText }  (all additions)
//   - patch               -> { mode:'unified', patchText }  (already a unified
//                             diff — parse its hunks directly, do NOT recompute)

/** A single rendered diff line. */
export type DiffRowKind = 'add' | 'del' | 'ctx' | 'meta';
export interface DiffRow {
  kind: DiffRowKind;
  text: string;
}

/** Extraction result: enough for a caller to render without re-inspecting input. */
export type ToolDiff =
  | { mode: 'lcs'; oldText: string; newText: string; caption: string }
  | { mode: 'unified'; patchText: string; caption: string };

/** Max lines per side before we bail out of the O(n*m) LCS table. */
export const DIFF_MAX_LINES = 5000;

function asObject(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    const s = input.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
  if (input && typeof input === 'object') return input as Record<string, unknown>;
  return null;
}

/**
 * Recognise the edit-family tools and pull a renderable diff descriptor out of
 * their input. Returns null when the tool doesn't carry diffable input.
 *
 * @param toolName canonical or aliased tool name.
 * @param input    tool input — a parsed object OR a JSON string.
 */
export function diffFromToolInput(toolName: string | undefined, input: unknown): ToolDiff | null {
  if (!toolName) return null;
  const obj = asObject(input);
  if (!obj) return null;
  const name = toolName.toLowerCase();
  const filePath = String(obj.file_path ?? obj.path ?? '');

  switch (name) {
    case 'edit':
    case 'str_replace':
    case 'edit_file':
    case 'multi_edit': {
      const oldText = typeof obj.old_string === 'string' ? obj.old_string : '';
      const newText = typeof obj.new_string === 'string' ? obj.new_string : '';
      if (!oldText && !newText) return null;
      return { mode: 'lcs', oldText, newText, caption: `edit ${filePath}`.trim() };
    }
    case 'write':
    case 'write_file':
    case 'create_file': {
      const content = typeof obj.content === 'string' ? obj.content : '';
      if (!content) return null;
      // Fresh write: no "old" side, everything shows green.
      return {
        mode: 'lcs',
        oldText: '',
        newText: content,
        caption: `write ${filePath} (new)`.trim(),
      };
    }
    case 'patch': {
      const patchText = typeof obj.patch === 'string' ? obj.patch : '';
      if (!patchText.trim()) return null;
      return { mode: 'unified', patchText, caption: filePath ? `patch ${filePath}` : 'patch' };
    }
    default:
      return null;
  }
}

/**
 * LCS-based line diff. Returns null when either side exceeds DIFF_MAX_LINES
 * (an O(n*m) memory guard — fine for a normal edit, prohibitive for a huge
 * generated-file rewrite).
 */
export function computeLineDiff(oldText: string, newText: string): DiffRow[] | null {
  const a = oldText.split('\n').map((l) => l.replace(/\r$/, ''));
  const b = newText.split('\n').map((l) => l.replace(/\r$/, ''));
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      rows.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) rows.push({ kind: 'del', text: a[i++]! });
  while (j < m) rows.push({ kind: 'add', text: b[j++]! });
  return rows;
}

/**
 * `@@ -a,b +c,d @@` — the hunk header, carrying the declared body lengths.
 *
 * `b`/`d` default to 1 when the header omits them (the unified-diff
 * convention); a header that declares no counts at all does not match.
 */
const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/** The old/new body lengths a hunk header declares, or null when it declares none. */
function hunkLineCounts(header: string): { old: number; new: number } | null {
  const match = HUNK_HEADER_RE.exec(header);
  if (!match) return null;
  return {
    old: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    new: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
  };
}

/**
 * A `--- ` line immediately followed by a `+++ ` line: the file-header pair.
 *
 * Inside a hunk, testing either prefix on its own also caught BODY lines — a
 * removed `-- SQL comment` is `--- SQL comment`, a removed markdown `---` rule
 * is `----`, an added `++i;` is `+++i;` — which were then shown as headers (or
 * dropped, shifting every later line number) instead of as the change.
 *
 * The PAIR itself is ambiguous: a removed `-- comment` source line and an
 * added `++ comment` source line that git emits adjacently are byte-for-byte
 * the shape of a file header. The callers therefore combine this predicate
 * with the hunk's DECLARED line counts — the pair is a header only once the
 * hunk body it could belong to is exhausted. Same rule core's
 * `countUnifiedDiffLines` and the TUI's `countUnifiedDiffChanges` apply.
 */
function isFileHeaderPair(lines: readonly string[], index: number): boolean {
  return (lines[index] ?? '').startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ ');
}

/**
 * Parse a unified-diff string into renderable rows. Hunk headers (`@@ ... @@`)
 * and file headers (`--- `, `+++ `, `diff `, `index `) become `meta` rows; body
 * lines map to add/del/ctx by their leading char. `\ No newline at end of file`
 * is kept as a meta row.
 */
export function parseUnifiedDiff(patchText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = patchText.split('\n').map((r) => r.replace(/\r$/, ''));
  let sawHunk = false;
  // Lines the CURRENT hunk still owes on each side. A `--- `/`+++ ` pair is
  // the file header only once the hunk body it could belong to is exhausted.
  let oldRemaining = 0;
  let newRemaining = 0;
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k] ?? '';
    if (raw.startsWith('@@')) {
      sawHunk = true;
      const counts = hunkLineCounts(raw);
      oldRemaining = counts?.old ?? 0;
      newRemaining = counts?.new ?? 0;
    } else if (raw.startsWith('diff ')) {
      sawHunk = false;
      oldRemaining = 0;
      newRemaining = 0;
    }
    if (isFileHeaderPair(lines, k) && oldRemaining <= 0 && newRemaining <= 0) {
      rows.push({ kind: 'meta', text: raw }, { kind: 'meta', text: lines[k + 1] ?? '' });
      k++;
      sawHunk = false;
      oldRemaining = 0;
      newRemaining = 0;
      continue;
    }
    if (
      (!sawHunk && (raw.startsWith('--- ') || raw.startsWith('+++ '))) ||
      raw.startsWith('@@') ||
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('\\ ')
    ) {
      rows.push({ kind: 'meta', text: raw });
    } else if (raw.startsWith('+')) {
      rows.push({ kind: 'add', text: raw.slice(1) });
      newRemaining -= 1;
    } else if (raw.startsWith('-')) {
      rows.push({ kind: 'del', text: raw.slice(1) });
      oldRemaining -= 1;
    } else {
      // context line (leading space) or a bare line
      rows.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw });
      oldRemaining -= 1;
      newRemaining -= 1;
    }
  }
  // Drop a trailing empty row that a final newline in patchText introduces.
  if (
    rows.length > 0 &&
    rows[rows.length - 1]!.kind === 'ctx' &&
    rows[rows.length - 1]!.text === ''
  ) {
    rows.pop();
  }
  return rows;
}

/**
 * Convenience: extract + render to rows in one call. Returns null when the tool
 * carries no diffable input, or `{ caption, rows: null }` when the diff is too
 * large to render (LCS guard).
 */
export function diffRowsFromToolInput(
  toolName: string | undefined,
  input: unknown,
): { caption: string; rows: DiffRow[] | null } | null {
  const d = diffFromToolInput(toolName, input);
  if (!d) return null;
  if (d.mode === 'unified') return { caption: d.caption, rows: parseUnifiedDiff(d.patchText) };
  return { caption: d.caption, rows: computeLineDiff(d.oldText, d.newText) };
}

// ===========================================================================
// Rich preview model (line-number gutters + maxLines cap + hidden counts).
//
// Promoted verbatim from the TUI's code-block.tsx so the terminal can consume
// this instead of a third local copy. It is a SUPERSET of the flat DiffRow
// model above: `DiffLineRow` carries per-row old/new line numbers and a `hunk`
// kind, and `parseUnifiedDiffPreview` returns a `DiffPreview` with add/remove
// totals plus a maxLines cap that folds the overflow into hidden counts.
//
// This is pure and browser-safe; the TUI-only rendering (ink/theme/wrap) stays
// in code-block.tsx. Kept as separate names from the flat `parseUnifiedDiff`
// above so WebUI/HQ callers are unaffected.
// ===========================================================================

/** Rich diff row: like DiffRow but with a dedicated `hunk` kind and gutters. */
export type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx' | 'meta';
export interface DiffLineRow {
  kind: DiffLineKind;
  text: string;
  oldLine?: number | undefined;
  newLine?: number | undefined;
}

/** A parsed unified-diff preview: rows plus visible/hidden tallies. */
export interface DiffPreview {
  rows: DiffLineRow[];
  hidden: number;
  added: number;
  removed: number;
  hiddenAdded: number;
  hiddenRemoved: number;
}

/**
 * Safety cap on a single diff row's stored text — guards against pathological
 * one-line files (minified bundles, huge JSON) flooding a consumer. Real code
 * lines are never truncated at this length.
 */
export const DIFF_LINE_SAFETY_CAP = 4000;

/** Truncate the middle-out: keep the head, append an ellipsis, past `max`. */
export function truncMid(s: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return '';
  if (s.length <= max) return s;
  if (max === 1) return '…';
  // Never cut a surrogate pair: a lone high surrogate renders as a replacement glyph.
  let end = max - 1;
  if (end > 0) {
    const last = s.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return `${s.slice(0, end)}…`;
}

/**
 * Parse a unified-diff string into a {@link DiffPreview} with per-row line
 * numbers and add/remove tallies. `maxLines` caps the visible rows; the rest
 * fold into `hidden`/`hiddenAdded`/`hiddenRemoved`. Pass
 * `Number.POSITIVE_INFINITY` to render everything.
 *
 * This is the richer sibling of {@link parseUnifiedDiff}: it keeps a dedicated
 * `hunk` kind (rather than folding hunk headers into `meta`) and tracks old/new
 * line gutters, which a terminal/gutter renderer needs.
 */
export function parseUnifiedDiffPreview(
  diff: string,
  maxLines: number,
  lineCap: number = DIFF_LINE_SAFETY_CAP,
): DiffPreview {
  const all: DiffLineRow[] = [];
  let oldLn = 0;
  let newLn = 0;
  const lines = diff.split('\n').map((raw) => raw.replace(/\r$/, ''));
  let sawHunk = false;
  // Lines the CURRENT hunk still owes on each side. A `--- `/`+++ ` pair is
  // the file header only once the hunk body it could belong to is exhausted.
  let oldRemaining = 0;
  let newRemaining = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k] ?? '';
    if (line.startsWith('@@')) {
      sawHunk = true;
      const m = HUNK_HEADER_RE.exec(line);
      if (m) {
        oldLn = Number.parseInt(m[1] ?? '0', 10) || 0;
        newLn = Number.parseInt(m[3] ?? '0', 10) || 0;
        oldRemaining = Number.parseInt(m[2] ?? '1', 10);
        newRemaining = Number.parseInt(m[4] ?? '1', 10);
      } else {
        oldRemaining = 0;
        newRemaining = 0;
      }
      all.push({ kind: 'hunk', text: truncMid(line, 60) });
      continue;
    }
    if (line.startsWith('diff --git')) {
      sawHunk = false;
      oldRemaining = 0;
      newRemaining = 0;
      continue;
    }
    if (isFileHeaderPair(lines, k) && oldRemaining <= 0 && newRemaining <= 0) {
      k++;
      sawHunk = false;
      oldRemaining = 0;
      newRemaining = 0;
      continue;
    }
    if (!sawHunk && (line.startsWith('+++') || line.startsWith('---'))) continue;
    if (line.startsWith('index ')) continue;
    if (line.startsWith('+')) {
      all.push({ kind: 'add', text: truncMid(line, lineCap), newLine: newLn });
      newLn++;
      newRemaining -= 1;
      continue;
    }
    if (line.startsWith('-')) {
      all.push({ kind: 'del', text: truncMid(line, lineCap), oldLine: oldLn });
      oldLn++;
      oldRemaining -= 1;
      continue;
    }
    if (line.startsWith('\\ No newline')) {
      all.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.length === 0) continue;
    all.push({ kind: 'ctx', text: truncMid(line, lineCap), oldLine: oldLn, newLine: newLn });
    oldLn++;
    newLn++;
    oldRemaining -= 1;
    newRemaining -= 1;
  }
  const added = all.filter((row) => row.kind === 'add').length;
  const removed = all.filter((row) => row.kind === 'del').length;
  if (all.length === 0) {
    return { rows: [], hidden: 0, added: 0, removed: 0, hiddenAdded: 0, hiddenRemoved: 0 };
  }
  const safeMaxLines =
    maxLines === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(maxLines) && maxLines > 0
        ? Math.floor(maxLines)
        : 0;
  if (all.length <= safeMaxLines) {
    return { rows: all, hidden: 0, added, removed, hiddenAdded: 0, hiddenRemoved: 0 };
  }
  const rows = all.slice(0, safeMaxLines);
  const hiddenRows = all.slice(safeMaxLines);
  return {
    rows,
    hidden: hiddenRows.length,
    added,
    removed,
    hiddenAdded: hiddenRows.filter((row) => row.kind === 'add').length,
    hiddenRemoved: hiddenRows.filter((row) => row.kind === 'del').length,
  };
}

// ---------------------------------------------------------------------------
// Browser-JS transcriptions for HQ (served template literal, cannot import).
// Authored with string concatenation only: NO backticks, NO ${...} — the HQ
// template escapes those. A parity test asserts identical output to the TS
// functions above. Together these define, on the global scope:
//   diffFromToolInput(name, rawInput) -> {mode,...}|null
//   computeLineDiff(oldText, newText) -> rows|null
//   parseUnifiedDiff(patchText)       -> rows
//   diffRowsFromToolInput(name, raw)  -> {caption, rows}|null
// ---------------------------------------------------------------------------
export const TOOL_DIFF_BROWSER_SRC: string = [
  'var DIFF_MAX_LINES = 5000;',
  'function __diffObj(input){',
  '  if(typeof input==="string"){ var s=input.trim(); if(s.charAt(0)==="{"||s.charAt(0)==="["){ try{ var p=JSON.parse(s); if(p&&typeof p==="object") return p; }catch(_e){} } return null; }',
  '  if(input&&typeof input==="object") return input; return null;',
  '}',
  'function diffFromToolInput(name, input){',
  '  if(!name) return null;',
  '  var obj=__diffObj(input); if(!obj) return null;',
  '  var n=String(name).toLowerCase();',
  '  var fp=String(obj.file_path!=null?obj.file_path:(obj.path!=null?obj.path:""));',
  '  if(n==="edit"||n==="str_replace"||n==="edit_file"||n==="multi_edit"){',
  '    var oldT=typeof obj.old_string==="string"?obj.old_string:"";',
  '    var newT=typeof obj.new_string==="string"?obj.new_string:"";',
  '    if(!oldT&&!newT) return null;',
  '    return { mode:"lcs", oldText:oldT, newText:newT, caption:("edit "+fp).replace(/\\s+$/,"") };',
  '  }',
  '  if(n==="write"||n==="write_file"||n==="create_file"){',
  '    var c=typeof obj.content==="string"?obj.content:"";',
  '    if(!c) return null;',
  '    return { mode:"lcs", oldText:"", newText:c, caption:("write "+fp+" (new)").replace(/^\\s+/,"").replace(/\\s+$/,"") };',
  '  }',
  '  if(n==="patch"){',
  '    var pt=typeof obj.patch==="string"?obj.patch:"";',
  '    if(!pt.replace(/\\s/g,"")) return null;',
  '    return { mode:"unified", patchText:pt, caption: fp ? ("patch "+fp) : "patch" };',
  '  }',
  '  return null;',
  '}',
  'function computeLineDiff(oldText, newText){',
  '  var a=oldText.split("\\n").map(function(l){return l.replace(/\\r$/,"");}), b=newText.split("\\n").map(function(l){return l.replace(/\\r$/,"");});',
  '  if(a.length>DIFF_MAX_LINES||b.length>DIFF_MAX_LINES) return null;',
  '  var nn=a.length, mm=b.length, i, j;',
  '  var dp=new Array(nn+1); for(i=0;i<=nn;i++){ dp[i]=new Array(mm+1); for(j=0;j<=mm;j++) dp[i][j]=0; }',
  '  for(i=nn-1;i>=0;i--){ for(j=mm-1;j>=0;j--){ dp[i][j]= a[i]===b[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]); } }',
  '  var rows=[]; i=0; j=0;',
  '  while(i<nn&&j<mm){ if(a[i]===b[j]){ rows.push({kind:"ctx",text:a[i]}); i++; j++; } else if(dp[i+1][j]>=dp[i][j+1]){ rows.push({kind:"del",text:a[i]}); i++; } else { rows.push({kind:"add",text:b[j]}); j++; } }',
  '  while(i<nn){ rows.push({kind:"del",text:a[i]}); i++; }',
  '  while(j<mm){ rows.push({kind:"add",text:b[j]}); j++; }',
  '  return rows;',
  '}',
  'function __hunkCounts(header){ var m=/^@@\\s+-(\\d+)(?:,(\\d+))?\\s+\\+(\\d+)(?:,(\\d+))?\\s+@@/.exec(header); if(!m){ return null; } return {old: m[2]===undefined?1:parseInt(m[2],10), neu: m[4]===undefined?1:parseInt(m[4],10)}; }',
  'function parseUnifiedDiff(patchText){',
  '  var rows=[], lines=patchText.split("\\n").map(function(l){return l.replace(/\\r$/,"");}), k, raw, sawHunk=false, oldRem=0, newRem=0, c;',
  '  for(k=0;k<lines.length;k++){ raw=lines[k];',
  '    if(raw.indexOf("@@")===0){ sawHunk=true; c=__hunkCounts(raw); oldRem=c?c.old:0; newRem=c?c.neu:0; }',
  '    else if(raw.indexOf("diff ")===0){ sawHunk=false; oldRem=0; newRem=0; }',
  '    if(raw.indexOf("--- ")===0&&k+1<lines.length&&lines[k+1].indexOf("+++ ")===0&&oldRem<=0&&newRem<=0){ rows.push({kind:"meta",text:raw}); rows.push({kind:"meta",text:lines[k+1]}); k++; sawHunk=false; oldRem=0; newRem=0; continue; }',
  '    if((!sawHunk&&(raw.indexOf("--- ")===0||raw.indexOf("+++ ")===0))||raw.indexOf("@@")===0||raw.indexOf("diff ")===0||raw.indexOf("index ")===0||raw.indexOf("\\\\ ")===0){ rows.push({kind:"meta",text:raw}); }',
  '    else if(raw.charAt(0)==="+"){ rows.push({kind:"add",text:raw.slice(1)}); newRem--; }',
  '    else if(raw.charAt(0)==="-"){ rows.push({kind:"del",text:raw.slice(1)}); oldRem--; }',
  '    else { rows.push({kind:"ctx",text: raw.charAt(0)===" " ? raw.slice(1) : raw}); oldRem--; newRem--; }',
  '  }',
  '  if(rows.length>0 && rows[rows.length-1].kind==="ctx" && rows[rows.length-1].text===""){ rows.pop(); }',
  '  return rows;',
  '}',
  'function diffRowsFromToolInput(name, input){',
  '  var d=diffFromToolInput(name, input); if(!d) return null;',
  '  if(d.mode==="unified") return { caption:d.caption, rows:parseUnifiedDiff(d.patchText) };',
  '  return { caption:d.caption, rows:computeLineDiff(d.oldText, d.newText) };',
  '}',
].join('\n');
