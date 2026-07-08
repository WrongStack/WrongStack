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
      return { mode: 'lcs', oldText: '', newText: content, caption: `write ${filePath} (new)`.trim() };
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
  const a = oldText.split('\n');
  const b = newText.split('\n');
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
 * Parse a unified-diff string into renderable rows. Hunk headers (`@@ ... @@`)
 * and file headers (`--- `, `+++ `, `diff `, `index `) become `meta` rows; body
 * lines map to add/del/ctx by their leading char. `\ No newline at end of file`
 * is kept as a meta row.
 */
export function parseUnifiedDiff(patchText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = patchText.split('\n');
  for (const raw of lines) {
    if (
      raw.startsWith('@@') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('\\ ')
    ) {
      rows.push({ kind: 'meta', text: raw });
    } else if (raw.startsWith('+')) {
      rows.push({ kind: 'add', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      rows.push({ kind: 'del', text: raw.slice(1) });
    } else {
      // context line (leading space) or a bare line
      rows.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw });
    }
  }
  // Drop a trailing empty row that a final newline in patchText introduces.
  if (rows.length > 0 && rows[rows.length - 1]!.kind === 'ctx' && rows[rows.length - 1]!.text === '') {
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
  '    return { mode:"lcs", oldText:"", newText:c, caption:("write "+fp+" (new)").replace(/\\s+/g," ").replace(/\\s+$/,"") };',
  '  }',
  '  if(n==="patch"){',
  '    var pt=typeof obj.patch==="string"?obj.patch:"";',
  '    if(!pt.replace(/\\s/g,"")) return null;',
  '    return { mode:"unified", patchText:pt, caption: fp ? ("patch "+fp) : "patch" };',
  '  }',
  '  return null;',
  '}',
  'function computeLineDiff(oldText, newText){',
  '  var a=oldText.split("\\n"), b=newText.split("\\n");',
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
  'function parseUnifiedDiff(patchText){',
  '  var rows=[], lines=patchText.split("\\n"), k, raw;',
  '  for(k=0;k<lines.length;k++){ raw=lines[k];',
  '    if(raw.indexOf("@@")===0||raw.indexOf("--- ")===0||raw.indexOf("+++ ")===0||raw.indexOf("diff ")===0||raw.indexOf("index ")===0||raw.indexOf("\\\\ ")===0){ rows.push({kind:"meta",text:raw}); }',
  '    else if(raw.charAt(0)==="+"){ rows.push({kind:"add",text:raw.slice(1)}); }',
  '    else if(raw.charAt(0)==="-"){ rows.push({kind:"del",text:raw.slice(1)}); }',
  '    else { rows.push({kind:"ctx",text: raw.charAt(0)===" " ? raw.slice(1) : raw}); }',
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
