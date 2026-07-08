// Tool-aware one-line input summary — the single source of truth shared by the
// WebUI chat bubbles and the HQ dashboard chat-history sidebar.
//
// The whole point: 8 parallel `read` calls should NOT look identical, and a
// TodoWrite with 8 todos shouldn't dump 800 chars of JSON when "8 todos · 3
// done" tells the whole story.
//
// PURE DATA + PURE FUNCTION — no node imports — so it is safe to import from the
// browser (WebUI). The HQ dashboard is a served template-literal string that
// cannot `import` at runtime, so it embeds `SUMMARIZE_TOOL_INPUT_BROWSER_SRC`
// (an authored-once browser-JS transcription of the same logic) instead of a
// second hand-rolled copy. A test (`tool-summary.parity`) runs both against one
// fixture table to guarantee they never drift.
//
// Cases that earn a custom branch:
//   - TodoWrite          -> "8 todos · 3 done · 2 in-progress"
//   - batch/parallel     -> "N sub-tools · read, grep +2"
//   - edit / str_replace -> "edit foo.ts (3 → 5 lines)"
//   - write / create     -> "write foo.ts · 12 lines"
//   - bash / shell / exec -> "$ <command snippet>"
//   - fetch / http / web -> "GET https://…"
//   - grep / search      -> "grep <pattern> in <scope>"
//   - glob / find        -> "glob <pattern>"
//   - read               -> "read path (N…M)"
//   - fallback           -> first non-empty head field, else compact JSON.

/** Head-field lookup order for the generic fallback. */
export const FALLBACK_HEAD_FIELDS = [
  'path',
  'file_path',
  'pattern',
  'command',
  'cmd',
  'url',
  'query',
  'description',
  'content',
] as const;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function pickPath(obj: Record<string, unknown>): string {
  const p = obj.file_path ?? obj.path ?? obj.filepath;
  return typeof p === 'string' ? p : '';
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Normalize the two shapes callers hold: WebUI passes a parsed object; HQ holds
 * a JSON *string*. A string that parses to an object is treated as that object;
 * a string that does not parse is returned clipped as-is.
 */
function coerceInput(input: unknown): { obj: Record<string, unknown> | null; raw: unknown } {
  if (typeof input === 'string') {
    const s = input.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object') return { obj: parsed as Record<string, unknown>, raw: parsed };
      } catch {
        // fall through — non-JSON string
      }
    }
    return { obj: null, raw: input };
  }
  if (input && typeof input === 'object') return { obj: input as Record<string, unknown>, raw: input };
  return { obj: null, raw: input };
}

/**
 * One-line, tool-aware summary of a tool call's input.
 *
 * @param toolName canonical or aliased tool name (case-insensitive).
 * @param input    the tool input — a parsed object OR a JSON string.
 */
export function summarizeToolInput(toolName: string | undefined, input: unknown): string {
  if (input === null || input === undefined || input === '') return '';
  const { obj, raw } = coerceInput(input);
  if (!obj) return clip(String(raw), 120);

  const name = (toolName ?? '').toLowerCase();

  // ---- TodoWrite ----------------------------------------------------
  if (/^todo(_?write)?$|^todos$/.test(name) || Array.isArray(obj.todos)) {
    const todos = (obj.todos ?? []) as Array<{ status?: string | undefined }>;
    if (Array.isArray(todos)) {
      const done = todos.filter((t) => t?.status === 'completed').length;
      const wip = todos.filter((t) => t?.status === 'in_progress').length;
      const parts = [`${todos.length} todo${todos.length === 1 ? '' : 's'}`];
      if (done > 0) parts.push(`${done} done`);
      if (wip > 0) parts.push(`${wip} in-progress`);
      return parts.join(' · ');
    }
  }

  // ---- batch_tool_use / parallel_tool_use ---------------------------
  if (/batch|parallel/.test(name) || Array.isArray(obj.tool_uses) || Array.isArray(obj.calls)) {
    const list = (obj.tool_uses ?? obj.calls ?? obj.batch) as unknown[];
    if (Array.isArray(list)) {
      const subNames = new Set<string>();
      for (const item of list) {
        if (item && typeof item === 'object' && 'name' in item) {
          subNames.add(String((item as { name: unknown }).name));
        } else if (item && typeof item === 'object' && 'tool' in item) {
          subNames.add(String((item as { tool: unknown }).tool));
        }
      }
      const preview = [...subNames].slice(0, 3).join(', ');
      const more = subNames.size > 3 ? ` +${subNames.size - 3}` : '';
      return `${list.length} sub-tool${list.length === 1 ? '' : 's'}${preview ? ` · ${preview}${more}` : ''}`;
    }
  }

  // ---- edit / str_replace / patch -----------------------------------
  if (/^(edit|str_replace|edit_file|patch)$/.test(name)) {
    const fp = pickPath(obj);
    const oldS = typeof obj.old_string === 'string' ? obj.old_string : '';
    const newS = typeof obj.new_string === 'string' ? obj.new_string : '';
    const oldLines = oldS ? oldS.split('\n').length : 0;
    const newLines = newS ? newS.split('\n').length : 0;
    return `edit ${fp || '(file)'}${oldLines || newLines ? ` (${oldLines} → ${newLines} lines)` : ''}`;
  }

  // ---- write / create -----------------------------------------------
  if (/^(write|write_file|create_file|new_file)$/.test(name)) {
    const fp = pickPath(obj);
    const c = typeof obj.content === 'string' ? obj.content : '';
    const lines = c ? c.split('\n').length : 0;
    return `write ${fp || '(file)'}${lines ? ` · ${lines} lines` : ''}`;
  }

  // ---- bash / shell / exec / run ------------------------------------
  if (/^(bash|shell|sh|exec|run|run_command|run_shell|command)$/.test(name)) {
    const cmd = (obj.command ?? obj.cmd ?? obj.script) as string | undefined;
    if (typeof cmd === 'string') return `$ ${clip(cmd, 110)}`;
  }

  // ---- fetch / http / web -------------------------------------------
  if (/^(fetch|http|web|web_fetch|web_search|webfetch|curl|request)$/.test(name)) {
    const url = obj.url as string | undefined;
    if (typeof url === 'string') {
      const method = (obj.method as string | undefined) ?? 'GET';
      return `${method.toUpperCase()} ${clip(url, 100)}`;
    }
  }

  // ---- grep / search ------------------------------------------------
  if (/^(grep|search|ripgrep|rg)$/.test(name)) {
    const pattern = obj.pattern as string | undefined;
    const scope = (obj.path ?? obj.glob ?? obj.type) as string | undefined;
    if (typeof pattern === 'string') {
      return scope ? `grep ${clip(pattern, 60)} in ${scope}` : `grep ${clip(pattern, 100)}`;
    }
  }

  // ---- glob / find --------------------------------------------------
  if (/^(glob|find)$/.test(name)) {
    const p = (obj.pattern ?? obj.glob) as string | undefined;
    if (typeof p === 'string') return `glob ${clip(p, 80)}`;
  }

  // ---- read with offset/limit --------------------------------------
  if (/^(read|read_file|cat|view)$/.test(name)) {
    const fp = pickPath(obj);
    const offset = obj.offset as number | undefined;
    const limit = obj.limit as number | undefined;
    if (fp && (typeof offset === 'number' || typeof limit === 'number')) {
      const start = offset ?? 0;
      const end = typeof limit === 'number' ? start + limit : '';
      return `read ${fp} (${start}…${end})`;
    }
    if (fp) return `read ${fp}`;
  }

  // ---- Fallback: first non-empty headline string field --------------
  for (const k of FALLBACK_HEAD_FIELDS) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) {
      return `${k}: ${clip(v, 100)}`;
    }
  }
  // Last resort: compact JSON.
  return clip(safeJson(raw), 120);
}

/**
 * Authored-once browser-JS transcription of `summarizeToolInput`, for surfaces
 * that cannot `import` at runtime (the HQ dashboard is a served template-literal
 * string). This is DELIBERATELY written with string concatenation and single
 * backslashes only: the HQ template literal escapes `\` and `` ` ``/`${` before
 * embedding, so this text must contain NO backticks and NO `${` sequences.
 *
 * Defines one global function: `toolInputSummary(name, rawInput)` where
 * rawInput is a JSON string (HQ's on-wire shape) or null.
 *
 * A parity test asserts this produces identical output to the TS function above.
 */
export const SUMMARIZE_TOOL_INPUT_BROWSER_SRC: string = [
  'function __clip(s,n){ s=String(s==null?"":s); return s.length>n ? s.slice(0,n-1)+"\\u2026" : s; }',
  'function toolInputSummary(name, rawInput){',
  '  if(rawInput==null || rawInput==="") return "";',
  '  var obj=null, raw=rawInput;',
  '  if(typeof rawInput==="string"){',
  '    var s=rawInput.trim();',
  '    if(s.charAt(0)==="{" || s.charAt(0)==="["){ try{ var pj=JSON.parse(s); if(pj && typeof pj==="object"){ obj=pj; raw=pj; } }catch(_e){} }',
  '  } else if(rawInput && typeof rawInput==="object"){ obj=rawInput; raw=rawInput; }',
  '  if(!obj) return __clip(String(raw),120);',
  '  var n=String(name==null?"":name).toLowerCase();',
  '  if(/^todo(_?write)?$|^todos$/.test(n) || Array.isArray(obj.todos)){',
  '    var todos=obj.todos||[];',
  '    if(Array.isArray(todos)){',
  '      var done=0, wip=0, ti;',
  '      for(ti=0; ti<todos.length; ti++){ var st=todos[ti]&&todos[ti].status; if(st==="completed") done++; else if(st==="in_progress") wip++; }',
  '      var tp=[todos.length+" todo"+(todos.length===1?"":"s")];',
  '      if(done>0) tp.push(done+" done"); if(wip>0) tp.push(wip+" in-progress");',
  '      return tp.join(" \\u00b7 ");',
  '    }',
  '  }',
  '  if(/batch|parallel/.test(n) || Array.isArray(obj.tool_uses) || Array.isArray(obj.calls)){',
  '    var list=obj.tool_uses||obj.calls||obj.batch;',
  '    if(Array.isArray(list)){',
  '      var names={}, ord=[], li, it, nm;',
  '      for(li=0; li<list.length; li++){ it=list[li]; if(it && typeof it==="object"){ nm=("name" in it)?it.name:(("tool" in it)?it.tool:null); if(nm!=null){ nm=String(nm); if(!names[nm]){ names[nm]=1; ord.push(nm); } } } }',
  '      var preview=ord.slice(0,3).join(", ");',
  '      var more=ord.length>3 ? " +"+(ord.length-3) : "";',
  '      return list.length+" sub-tool"+(list.length===1?"":"s")+(preview?(" \\u00b7 "+preview+more):"");',
  '    }',
  '  }',
  '  var fp;',
  '  if(/^(edit|str_replace|edit_file|patch)$/.test(n)){',
  '    fp=(obj.file_path!=null?obj.file_path:(obj.path!=null?obj.path:obj.filepath));',
  '    var oldS=typeof obj.old_string==="string"?obj.old_string:"";',
  '    var newS=typeof obj.new_string==="string"?obj.new_string:"";',
  '    var ol=oldS?oldS.split("\\n").length:0, nl=newS?newS.split("\\n").length:0;',
  '    var efp=typeof fp==="string"?fp:"";',
  '    return "edit "+(efp||"(file)")+((ol||nl)?(" ("+ol+" \\u2192 "+nl+" lines)"):"");',
  '  }',
  '  if(/^(write|write_file|create_file|new_file)$/.test(n)){',
  '    fp=(obj.file_path!=null?obj.file_path:(obj.path!=null?obj.path:obj.filepath));',
  '    var wc=typeof obj.content==="string"?obj.content:"";',
  '    var wl=wc?wc.split("\\n").length:0;',
  '    var wfp=typeof fp==="string"?fp:"";',
  '    return "write "+(wfp||"(file)")+(wl?(" \\u00b7 "+wl+" lines"):"");',
  '  }',
  '  if(/^(bash|shell|sh|exec|run|run_command|run_shell|command)$/.test(n)){',
  '    var cmd=(obj.command!=null?obj.command:(obj.cmd!=null?obj.cmd:obj.script));',
  '    if(typeof cmd==="string") return "$ "+__clip(cmd,110);',
  '  }',
  '  if(/^(fetch|http|web|web_fetch|web_search|webfetch|curl|request)$/.test(n)){',
  '    if(typeof obj.url==="string"){ var mth=(typeof obj.method==="string"?obj.method:"GET"); return mth.toUpperCase()+" "+__clip(obj.url,100); }',
  '  }',
  '  if(/^(grep|search|ripgrep|rg)$/.test(n)){',
  '    var pat=obj.pattern, scope=(obj.path!=null?obj.path:(obj.glob!=null?obj.glob:obj.type));',
  '    if(typeof pat==="string"){ return scope ? ("grep "+__clip(pat,60)+" in "+scope) : ("grep "+__clip(pat,100)); }',
  '  }',
  '  if(/^(glob|find)$/.test(n)){',
  '    var gp=(obj.pattern!=null?obj.pattern:obj.glob);',
  '    if(typeof gp==="string") return "glob "+__clip(gp,80);',
  '  }',
  '  if(/^(read|read_file|cat|view)$/.test(n)){',
  '    fp=(obj.file_path!=null?obj.file_path:(obj.path!=null?obj.path:obj.filepath));',
  '    if(typeof fp==="string" && fp){',
  '      var off=obj.offset, lim=obj.limit;',
  '      if(typeof off==="number" || typeof lim==="number"){ var start=(typeof off==="number"?off:0); var end=(typeof lim==="number"?(start+lim):""); return "read "+fp+" ("+start+"\\u2026"+end+")"; }',
  '      return "read "+fp;',
  '    }',
  '  }',
  '  var HEAD=["path","file_path","pattern","command","cmd","url","query","description","content"], hi;',
  '  for(hi=0; hi<HEAD.length; hi++){ var hv=obj[HEAD[hi]]; if(typeof hv==="string" && hv.length>0){ return HEAD[hi]+": "+__clip(hv,100); } }',
  '  var jsonStr; try{ jsonStr=JSON.stringify(raw); }catch(_e2){ jsonStr=String(raw); }',
  '  return __clip(jsonStr,120);',
  '}',
].join('\n');
