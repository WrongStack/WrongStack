import type { ChatMessage, FileEditMeta, TimelineEntry, ToolCallInfo } from '../types.js';

/** Interleave messages and tool calls into a single timeline ordered by timestamp. */
export function buildTimeline(messages: ChatMessage[], toolCalls: ToolCallInfo[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const m of messages) {
    entries.push({
      kind: 'message',
      ts: m.ts ?? '0',
      message: m,
    });
  }

  for (const tc of toolCalls) {
    entries.push({
      kind: 'tool_call',
      ts: tc.ts ?? '0',
      toolCall: tc,
    });
  }

  entries.sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    const orderA = a.kind === 'message' ? a.message?.replayOrder : a.toolCall?.replayOrder;
    const orderB = b.kind === 'message' ? b.message?.replayOrder : b.toolCall?.replayOrder;
    if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
    return 0;
  });

  return entries;
}

/** Tool names that touch the filesystem — these appear inline in the chat
 *  timeline as file-operation entries. Non-filesystem tools (delegate, task,
 *  kanban, etc.) stay in the tool sidebar only. */
const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'read', 'replace', 'glob', 'grep']);

/** Tools that actually mutate files — gates the "Files changed" stat badge
 *  so completed read/glob/grep calls don't leak into fileCount. */
const MUTATING_TOOLS = new Set(['edit', 'write', 'patch', 'replace']);

/** Returns true when a tool call should appear inline in the chat timeline
 *  (filesystem tools that edit/read/search files). */
export function isFileEditTool(toolCall: ToolCallInfo): boolean {
  return FILE_EDIT_TOOLS.has(toolCall.name);
}

/** Count lines added/removed from a unified diff string.
 *  Returns null if the string doesn't look like a diff. */
function countDiffLines(diff: string): { added: number; removed: number } | null {
  const start = diff.indexOf('@@');
  if (start === -1) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.slice(start).split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

/**
 * Parse the `key=value key=value …` header that `renderHeader()` in
 * `tool-output-serializer.ts` emits.  Used as a fallback when the tool
 * output is a formatted display string rather than raw JSON.
 */
function parseSerializedHeaderFields(header: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Keys are alphanumeric + underscore; values run until the next
  // key= (or end of string).  A space before a word that looks like
  // `key=` starts a new pair.
  let pos = 0;
  while (pos < header.length) {
    // skip whitespace
    while (pos < header.length && header[pos] === ' ') pos++;
    if (pos >= header.length) break;

    const eq = header.indexOf('=', pos);
    if (eq === -1) break;
    const key = header.slice(pos, eq);
    pos = eq + 1; // after '='

    // value runs until the next ` key=` pattern or end of string
    let end = header.length;
    const nextKey = header.slice(pos).search(/\s+\w+=/);
    if (nextKey !== -1) end = pos + nextKey;

    let value = header.slice(pos, end).trim();
    // strip surrounding quotes if both sides match
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
    pos = end;
  }
  return fields;
}

/** Remove context injected after the actual tool result before parsing it. */
function stripTrailingSageContext(output: string): string {
  return output.replace(/\r?\n\r?\n--- SAGE: [^\r\n]*\(Memory Injector\) ---[\s\S]*$/u, '');
}

/** Extract file edit metadata from a tool call's output/input, if this is a
 *  file-edit tool with a parseable result. */
export function extractFileEditMeta(toolCall: ToolCallInfo): FileEditMeta | null {
  if (!MUTATING_TOOLS.has(toolCall.name)) return null;

  // For read/glob/grep, extract the target path from input since output
  // is file content or search results (not a structured JSON result).
  const inputPath = extractPathFromInput(toolCall.name, toolCall.input);

  const rawOutput = toolCall.output;
  if (!rawOutput || typeof rawOutput !== 'string') {
    // No output yet (still running) — show the input path if we have one.
    if (inputPath) return { path: inputPath };
    return null;
  }
  const output = stripTrailingSageContext(rawOutput);

  // ── Path A: structured JSON (legacy / direct result objects) ──
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      const path = typeof parsed['path'] === 'string' ? parsed['path'] : (inputPath ?? '');
      if (!path) return null;

      const meta: FileEditMeta = { path };
      if (toolCall.ts) meta.ts = toolCall.ts;
      if (typeof parsed['replacements'] === 'number') meta.replacements = parsed['replacements'];
      if (typeof parsed['bytes_written'] === 'number') meta.bytesWritten = parsed['bytes_written'];
      if (typeof parsed['created'] === 'boolean') meta.created = parsed['created'];

      if (typeof parsed['diff'] === 'string' && parsed['diff']) {
        meta.diff = parsed['diff'];
        const counts = countDiffLines(parsed['diff']);
        if (counts) {
          meta.replacements = meta.replacements ?? counts.added;
        }
      }
      return meta;
    }
  } catch {
    // Not JSON — fall through to Path B.
  }

  // ── Path B: serialized display format ──
  // The tool-output serializer emits a structured header line followed by
  // diff content, e.g.:
  //   edit (path=src/file.ts replacements=1 matched_by=exact)
  //   @@ -1,3 +1,3 @@
  //    old
  //   +new
  //
  // Parse the header for metadata and extract the diff from the body.
  const nl = output.indexOf('\n');
  const headerLine = nl === -1 ? output : output.slice(0, nl);
  const rest = nl === -1 ? '' : output.slice(nl + 1);

  // Extract the parenthesised field block from the header.
  const parenStart = headerLine.indexOf('(');
  const parenEnd = headerLine.lastIndexOf(')');
  const fields =
    parenStart !== -1 && parenEnd > parenStart
      ? parseSerializedHeaderFields(headerLine.slice(parenStart + 1, parenEnd))
      : {};

  const path = fields['path'] || inputPath || '';
  if (!path) return null;

  const meta: FileEditMeta = { path };
  if (toolCall.ts) meta.ts = toolCall.ts;

  if (fields['replacements']) {
    const r = parseInt(fields['replacements'], 10);
    if (!Number.isNaN(r)) meta.replacements = r;
  }
  if (fields['bytes_written']) {
    const b = parseInt(fields['bytes_written'], 10);
    if (!Number.isNaN(b)) meta.bytesWritten = b;
  }
  if (fields['created'] === 'true') meta.created = true;

  // Extract unified diff: everything from the first `@@` hunk header onward.
  if (rest) {
    const diffStart = rest.indexOf('@@');
    if (diffStart !== -1) {
      meta.diff = rest.slice(diffStart);
      const counts = countDiffLines(meta.diff);
      if (counts) {
        meta.replacements = meta.replacements ?? counts.added;
      }
    }
  }

  return meta;
}

/** Try to extract a file path from a tool's input for read/glob/grep/replace. */
function extractPathFromInput(_name: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  // read, edit, write, patch: input has `path` field
  if (typeof obj['path'] === 'string' && obj['path'].trim()) return obj['path'].trim();
  // glob, grep, replace: input has `pattern` or `files` field
  if (typeof obj['pattern'] === 'string' && obj['pattern'].trim()) return obj['pattern'].trim();
  // replace: input has `files` field (glob pattern)
  if (typeof obj['files'] === 'string' && obj['files'].trim()) return obj['files'].trim();
  // grep: input has `path` as a directory to search
  if (typeof obj['path'] === 'string' && obj['path'].trim()) return obj['path'].trim();

  return null;
}

/** Aggregate file edit stats across all tool calls.
 *  Deduplicates by path (merges diffs for consecutive edits to the same
 *  file) and returns the list of unique file edits plus total added/removed
 *  line counts. */
export function aggregateFileEdits(toolCalls: ToolCallInfo[]): {
  files: FileEditMeta[];
  totalAdded: number;
  totalRemoved: number;
  fileCount: number;
} {
  const byPath = new Map<string, FileEditMeta>();

  for (const tc of toolCalls) {
    if (tc.status !== 'done') continue;
    // Only count mutating tools (edit/write/patch/replace) — read/glob/grep
    // are filesystem tools but don't change files and would inflate the badge.
    if (!MUTATING_TOOLS.has(tc.name)) continue;
    const meta = extractFileEditMeta(tc);
    if (!meta) continue;

    const existing = byPath.get(meta.path);
    if (existing) {
      // Merge with existing entry for the same file — concatenate diffs
      // (each partial diff keeps its own @@ hunk headers), accumulate counts.
      existing.replacements = (existing.replacements ?? 0) + (meta.replacements ?? 0);
      existing.bytesWritten = (existing.bytesWritten ?? 0) + (meta.bytesWritten ?? 0);
      if (meta.created) existing.created = true;
      if (tc.ts) existing.ts = tc.ts;
      if (meta.diff) {
        existing.diff = existing.diff ? existing.diff.trimEnd() + '\n' + meta.diff : meta.diff;
      }
    } else {
      byPath.set(meta.path, { ...meta });
    }
  }

  const files = [...byPath.values()];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const f of files) {
    if (f.diff) {
      const start = f.diff.indexOf('@@');
      if (start !== -1) {
        for (const line of f.diff.slice(start).split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) totalAdded++;
          else if (line.startsWith('-') && !line.startsWith('---')) totalRemoved++;
        }
      }
    }
  }

  return { files, totalAdded, totalRemoved, fileCount: files.length };
}
