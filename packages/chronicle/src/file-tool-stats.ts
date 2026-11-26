/** Compact numeric evidence from the complete result, before preview truncation. */
export function fileToolStats(
  name: string,
  output: string,
  input?: unknown,
): Record<string, unknown> | undefined {
  // `patch` is the odd one out: its result carries no diff at all, so it is
  // derived from the input diff instead and handled before the shared parse.
  if (name === 'patch') return patchToolStats(output, input);
  if (!['read', 'edit', 'write'].includes(name)) return undefined;
  const result = asObject(output);
  // The runtime serializes tool results for the event bus as human-readable
  // text (`createToolOutputSerializer` → `renderToolObject`), NOT as JSON —
  // the serialized formats below are what production `tool.executed` events
  // actually carry. The JSON envelope stays first because embedders and
  // tests can still hand over the raw structured result.
  if (name === 'read') {
    if (result && typeof result.text === 'string') {
      // `read` right-aligns line numbers to a common width, so every line before
      // a digit-width boundary is emitted with leading spaces ("  1→…"). Anchor on
      // optional whitespace or those lines are silently dropped from the count.
      const lines = result.text.split(/\r?\n/).filter((line) => /^\s*\d+→/.test(line));
      // Summary, binary, PDF, and already-shown stubs have no numbered source lines.
      if (!lines.length) return undefined;
      return {
        readLines: lines.length,
        ...(Number.isInteger(result.total_lines) && Number(result.total_lines) >= 0
          ? { totalLines: result.total_lines }
          : {}),
      };
    }
    return serializedReadStats(output);
  }
  if (name === 'write' && result?.created === true && typeof result.diff === 'string') {
    const created = /^\+\+\+ [^\r\n]+\r?\n\+ \(new file, (\d+) lines\)$/.exec(result.diff);
    if (created) return { addedLines: Number(created[1]), removedLines: 0, partial: false };
  }
  if (result && typeof result.diff === 'string' && result.diff.startsWith('--- ')) {
    const { addedLines, removedLines } = countHunks(result.diff);
    return {
      addedLines,
      removedLines,
      partial: typeof result.note === 'string' && /diff truncated/i.test(result.note),
    };
  }
  // Serialized `write` for a new file: `write (… created=true)` followed by a
  // one-line diff whose marker names the exact size.
  if (name === 'write') {
    const created = /\r?\n\+\+\+ [^\r\n]+\r?\n\+ \(new file, (\d+) lines\)/.exec(output);
    if (created) return { addedLines: Number(created[1]), removedLines: 0, partial: false };
  }
  return serializedDiffStats(output);
}

/**
 * `read` as the event bus actually carries it: a `read: <path> (…)` header
 * line followed by the numbered source lines. Counting `N→` prefixes over
 * the whole output is exact — only source lines carry the marker.
 *
 * The event envelope caps `output` at ~400 chars (`truncateForEvent`), so
 * for most reads only the first few numbered lines survive; those counts
 * are a LOWER BOUND and are marked partial. The exact count over the full
 * output is persisted separately as `outputLines` (sizeSignals) — consumers
 * that need exactness prefer it.
 */
function serializedReadStats(output: string): Record<string, unknown> | undefined {
  const lines = output.split(/\r?\n/);
  let readLines = 0;
  for (const line of lines) if (/^\s*\d+→/.test(line)) readLines++;
  // Summary, binary, PDF, and already-shown stubs have no numbered source lines.
  if (!readLines) return undefined;
  const header = /total_lines=(\d+)/.exec(lines[0] ?? '');
  return {
    readLines,
    // `truncateForEvent` marks a cut with a trailing ellipsis; a count over a
    // truncated body undercounts reality and must never read as exact.
    partial: output.endsWith('…'),
    ...(header ? { totalLines: Number(header[1]) } : {}),
  };
}

/**
 * Line deltas from the serialized `edit`/`write` result. The diff rides in
 * the text after the `tool (path=…)` header, anchored by its own `--- `/`+++ `
 * pair so hunk-body lines that merely start with those prefixes are never
 * mistaken for the start.
 *
 * A diff the renderer clipped (`compactDiff`, >260 lines) still names the
 * EXACT totals in its `diff_summary (… added=N removed=N …)` header — prefer
 * that over counting visible hunks. Anything the tool itself cut in transit
 * carries `…[diff truncated:`, and those counts understate reality, so they
 * are marked partial.
 */
function serializedDiffStats(output: string): Record<string, unknown> | undefined {
  const lines = output.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i]!.startsWith('--- ') && lines[i + 1]!.startsWith('+++ ')) {
      start = i;
      break;
    }
  }
  // No-op edits and identical overwrites produce no diff at all.
  if (start === -1) return undefined;
  // Only the renderer's pre-diff header carries totals; hunk content is source text.
  const summary = /^diff_summary \([^\r\n)]*\badded=(\d+) removed=(\d+)\b[^\r\n)]*\)$/m.exec(
    lines.slice(0, start).join('\n'),
  );
  if (summary) {
    return {
      addedLines: Number(summary[1]),
      removedLines: Number(summary[2]),
      partial: output.includes('…[diff truncated:'),
    };
  }
  const { addedLines, removedLines } = countHunks(lines.slice(start).join('\n'));
  if (!addedLines && !removedLines) return undefined;
  return {
    addedLines,
    removedLines,
    partial: output.includes('…[diff truncated:'),
  };
}

/** One file addressed by a multi-file diff, with its own line deltas. */
interface PatchFileDelta {
  path: string;
  addedLines: number;
  removedLines: number;
}

/**
 * `patch` returns only `{applied, rejected, files, dry_run, message}` — the
 * unified diff it applied never appears in the result, so line counts have to
 * come from the tool input. Deltas are kept per file because one patch call
 * routinely spans several files, and the Files tab is keyed by path.
 */
function patchToolStats(output: string, input: unknown): Record<string, unknown> | undefined {
  const result = asObject(output);
  if (!result) return undefined;
  // A dry run wrote nothing, so counting it would invent file activity.
  if (result.dry_run === true) return undefined;
  // A reject means some hunks did not land, and a unified diff carries no
  // per-hunk reject markers — there is no way to tell which file's deltas
  // actually applied, so crediting the whole diff would overstate the change.
  // Today `patch` only reports a non-zero `rejected` on a dry run (a real
  // failed apply throws, so it never reaches here as a success); this keeps the
  // guarantee local instead of depending on that contract holding elsewhere.
  if (typeof result.rejected === 'number' && result.rejected > 0) return undefined;
  if (typeof result.applied === 'number' && result.applied <= 0) return undefined;
  const args = asObject(input);
  const diff = args && typeof args.patch === 'string' ? args.patch : undefined;
  if (!diff) return undefined;
  const strip =
    typeof args?.strip === 'number' && Number.isInteger(args.strip) && args.strip >= 0
      ? args.strip
      : 1;
  const files = patchFileDeltas(diff, strip);
  if (!files.files.length) return undefined;
  return {
    addedLines: files.files.reduce((total, file) => total + file.addedLines, 0),
    removedLines: files.files.reduce((total, file) => total + file.removedLines, 0),
    // A diff that still had a hunk open at EOF was cut short in transit (the
    // subagent bridge bounds the body), so these totals undercount reality.
    partial: files.truncated,
    patchFiles: files.files,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split a unified diff into per-file line deltas.
 *
 * A file header is only recognised OUTSIDE a hunk. Inside one, the same
 * prefixes are ordinary body lines — a removed `-- SQL comment` is
 * `--- SQL comment` and an added `++i;` is `+++i;` — so keying off the
 * prefix alone would invent a file for every such line. A hunk's extent comes
 * from the line counts its `@@` header declares, which is what tells us when
 * the next header pair is genuinely a new file.
 */
function patchFileDeltas(
  diff: string,
  strip: number,
): { files: PatchFileDelta[]; truncated: boolean } {
  const lines = diff.split(/\r?\n/);
  const files: PatchFileDelta[] = [];
  let current: PatchFileDelta | undefined;
  let inHunk = false;
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inHunk && line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      // `/dev/null` is matched BEFORE stripping: `patch -p1` would otherwise
      // reduce it to `dev/null` and a deletion would be attributed to a file
      // that does not exist. Strip optional GNU diff `\t<timestamp>` metadata.
      const rawOld = line.slice(4).split('\t')[0]!.trim();
      const rawNew = lines[i + 1]!.slice(4).split('\t')[0]!.trim();
      const path =
        rawNew === '/dev/null'
          ? stripComponents(rawOld, strip)
          : rawOld === '/dev/null'
            ? stripComponents(rawNew, strip)
            : stripComponents(rawNew, strip);
      if (path && path !== '/dev/null') {
        current = { path, addedLines: 0, removedLines: 0 };
        files.push(current);
      } else {
        current = undefined;
      }
      i++; // consume the `+++` half of the header pair
      continue;
    }
    const hunk = /^@@+\s+-\d+(?:,(\d+))?\s+\+\d+(?:,(\d+))?\s+@@/.exec(line);
    if (hunk) {
      // An omitted count means one line, per unified-diff convention.
      inHunk = true;
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith('+')) {
      current.addedLines++;
      newLeft--;
    } else if (line.startsWith('-')) {
      current.removedLines++;
      oldLeft--;
    } else if (line.startsWith(' ') || line === '') {
      // A blank source line's context marker is a single space, which some
      // producers (and any trailing-whitespace stripper) deliver as an empty
      // string. It is still a context line, so it must consume one line from
      // BOTH sides. Skipping it left `oldLeft`/`newLeft` short, the hunk never
      // closed, and every following file's header pair was then counted as
      // content of THIS file — inflating its totals and dropping those files
      // from `patchFiles` entirely.
      oldLeft--;
      newLeft--;
    }
    // `\ No newline at end of file` belongs to the preceding line and
    // consumes neither side's count.
    if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
  }
  return {
    files: files.filter((file) => file.addedLines > 0 || file.removedLines > 0),
    // Still inside a hunk at EOF means the body was cut off before the diff
    // ended, so the last file's counts are known-incomplete.
    truncated: inHunk,
  };
}

/** `patch -pN`: drop N leading slash-separated components, GNU-style. */
function stripComponents(path: string, strip: number): string {
  let rest = path.replace(/\\/g, '/');
  for (let i = 0; i < strip; i++) {
    const slash = rest.indexOf('/');
    if (slash === -1) return rest;
    rest = rest.slice(slash + 1);
  }
  return rest;
}

/** Count added/removed lines inside `@@` hunks, ignoring file headers. */
function countHunks(diff: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) addedLines++;
    if (line.startsWith('-')) removedLines++;
  }
  return { addedLines, removedLines };
}
