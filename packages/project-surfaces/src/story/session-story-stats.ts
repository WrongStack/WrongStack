import type { buildSessionStory } from './session-story';

/** One row of the Files tab: a path plus the evidence measured for it. */
interface FileRow {
  path: string;
  reads: number;
  edits: number;
  writes: number;
  readLines: number;
  added: number;
  removed: number;
  readMeasured: number;
  changeMeasured: number;
  partial: boolean;
  /**
   * A FAILED call left this file changed on disk (e.g. `patch --merge` writing
   * conflict markers). The file exists and is damaged; a failed call produces
   * no line evidence, so every count stays zero and the row MUST be labelled —
   * a silent zero row is indistinguishable from "never touched".
   */
  conflicted: boolean;
}

export function storyStats(story: ReturnType<typeof buildSessionStory>, projectRoot = '') {
  let conflictedTruncated = false;
  const calls = new Map<
    string,
    { name: string; path?: string; end?: (typeof story.events)[number]; started: boolean }
  >();
  for (const event of story.events) {
    const raw = event.raw;
    if (
      !raw ||
      !/^(tool\.(started|executed|failed)|subagent\.tool_(started|executed|failed))$/.test(
        raw.eventType,
      )
    )
      continue;
    const attrs = raw.attributes ?? {};
    const id = raw.correlation.toolCallId ?? attrs.toolUseId ?? attrs.id ?? event.id;
    const key = `${event.actor}:${id}`;
    const call = calls.get(key) ?? { name: 'Unknown tool', started: false };
    const name = attrs.toolName ?? attrs.name;
    if (typeof name === 'string') call.name = name;
    if (event.path) call.path = event.path;
    if (/started$/.test(raw.eventType)) call.started = true;
    else call.end = event;
    calls.set(key, call);
  }
  const tools = new Map<
    string,
    {
      name: string;
      calls: number;
      success: number;
      failed: number;
      pending: number;
      durations: number[];
    }
  >();
  const files = new Map<string, FileRow>();
  const FILE_TOOLS = new Set(['read', 'edit', 'write', 'patch']);
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, '/');
    const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
    return root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      ? normalized.slice(root.length + 1)
      : normalized;
  };
  for (const path of story.files) {
    const normalized = normalize(path);
    files.set(/^[a-z]:/i.test(projectRoot || path) ? normalized.toLowerCase() : normalized, {
      path: normalized,
      reads: 0,
      edits: 0,
      writes: 0,
      readLines: 0,
      added: 0,
      removed: 0,
      readMeasured: 0,
      changeMeasured: 0,
      partial: false,
      conflicted: false,
    });
  }
  for (const call of calls.values()) {
    const tool = tools.get(call.name) ?? {
      name: call.name,
      calls: 0,
      success: 0,
      failed: 0,
      pending: 0,
      durations: [],
    };
    tool.calls++;
    if (!call.end) tool.pending++;
    else if (call.end.raw?.outcome === 'success') tool.success++;
    else if (['failure', 'denied', 'cancelled'].includes(call.end.raw?.outcome ?? ''))
      tool.failed++;
    else tool.pending++;
    if (call.end?.durationMs !== undefined) tool.durations.push(call.end.durationMs);
    tools.set(call.name, tool);
    // A FAILED call can still have left files changed on disk — `patch --merge`
    // writes conflict markers and then throws. Surface them as present but
    // damaged, with zero counts: a failed call yields no line evidence, and a
    // silent zero row would be indistinguishable from "never touched".
    if (call.end?.raw?.outcome === 'failure') {
      conflictedTruncated ||= markConflicted(files, call, normalize, projectRoot);
      continue;
    }
    if (call.end?.raw?.outcome !== 'success' || !FILE_TOOLS.has(call.name)) continue;
    // `patch` is not path-scoped: one call can address several files, so its
    // per-file deltas are attributed individually instead of via call.path.
    if (call.name === 'patch') {
      attributePatch(files, call, normalize, projectRoot);
      continue;
    }
    if (!call.path) continue;
    const path = normalize(call.path);
    const file = files.get(/^[a-z]:/i.test(projectRoot || call.path) ? path.toLowerCase() : path);
    if (!file) continue;
    if (call.name === 'read') file.reads++;
    if (call.name === 'edit') file.edits++;
    if (call.name === 'write') file.writes++;
    const attributes = call.end.raw.attributes ?? {};
    let stats = attributes.fileStats;
    if (!stats || typeof stats !== 'object') stats = {};
    const data = stats as Record<string, unknown>;
    const number = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    // Reads: `outputLines` is the exact numbered-line count over the FULL
    // output (sizeSignals, persisted since long before fileStats existed);
    // `fileStats.readLines` counts only what survived the event envelope's
    // ~400-char cap, so on post-fix events it can be a mere prefix — prefer
    // the exact number and fall back to the prefix.
    const read =
      (call.name === 'read' ? number(attributes.outputLines) : undefined) ?? number(data.readLines);
    if (read !== undefined) {
      file.readLines += read;
      file.readMeasured++;
    }
    let added = number(data.addedLines),
      removed = number(data.removedLines);
    let partial = data.partial === true;
    if (added === undefined || removed === undefined) {
      // Same fallback for edit/write: the serialized diff rides in
      // `outputPreview`, exact when the preview is whole and a lower bound
      // (marked partial) when the journal kept only a truncated copy.
      const derived = previewDiffStats(call.name, attributes.outputPreview);
      if (derived) {
        added = derived.addedLines;
        removed = derived.removedLines;
        partial ||= derived.partial;
      }
    }
    if (added !== undefined && removed !== undefined) {
      file.added += added;
      file.removed += removed;
      file.changeMeasured++;
      file.partial ||= partial;
    }
  }
  return {
    tools: [...tools.values()]
      .map((tool) => {
        const times = tool.durations.sort((a, b) => a - b);
        return {
          ...tool,
          measured: times.length,
          avg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : undefined,
          p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : undefined,
          total: times.reduce((a, b) => a + b, 0),
        };
      })
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    files: [...files.values()].sort(
      (a, b) =>
        b.edits + b.writes + b.reads - (a.edits + a.writes + a.reads) ||
        a.path.localeCompare(b.path),
    ),
    /**
     * Directories span EVERY row, including conflicted-only ones.
     *
     * DECIDED (this was an open side effect of `markConflicted`, left
     * undecided while the flag was being built):
     *
     * 1. A conflicted-only row is a file a failed call genuinely left changed on
     *    disk — `patch --merge` wrote conflict markers before it threw. That is
     *    the entire point of the badge, so the file is real and its parent
     *    directory really did see activity.
     * 2. Excluding them would make this aggregate incoherent with `files.length`,
     *    which `StoryTables` renders immediately beside it ("N recorded paths ·
     *    M directories"): a path would appear in the row list while its own
     *    directory was missing from the count.
     * 3. `directories` measures REACH, not success. The header already separates
     *    the two — "successful operations, plus any file a failed call left
     *    changed" — so folding conflicted rows in here needs no new caveat.
     * 4. The opposite choice would UNDERSTATE blast radius, which is the one
     *    thing this feature exists to prevent.
     */
    directories: new Set(
      [...files.values()].map((file) =>
        file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.',
      ),
    ).size,
    /**
     * At least one failed call reported MORE changed files than the chronicle
     * kept, so `conflicted` rows are a lower bound on the damage. Without this
     * the operator would read the surviving rows as a complete manifest.
     */
    conflictedTruncated,
  };
}

/**
 * Fallback line evidence for journals recorded before `attributes.fileStats`
 * existed: `edit`/`write` serialized their unified diff into `outputPreview`.
 * A string preview is the whole output (capPreview only truncates over its
 * byte budget), so counts from it are exact; the object form is a truncated
 * copy, so its counts are a lower bound and are marked partial.
 */
function previewDiffStats(
  name: string,
  preview: unknown,
): { addedLines: number; removedLines: number; partial: boolean } | undefined {
  if (name !== 'edit' && name !== 'write') return undefined;
  let text: string;
  let truncated: boolean;
  if (typeof preview === 'string') {
    text = preview;
    truncated = false;
  } else if (preview && typeof preview === 'object') {
    const record = preview as Record<string, unknown>;
    if (typeof record.preview !== 'string') return undefined;
    // The object form exists to flag truncation, but honour the flag itself:
    // an untruncated object must never be misread as a lower bound.
    truncated = record.truncated === true;
    text = record.preview;
  } else return undefined;
  // A diff the renderer clipped still names the exact totals in its
  // `diff_summary (… added=N removed=N …)` header.
  const summary = /diff_summary \([^)]*\badded=(\d+) removed=(\d+)/.exec(text);
  if (summary) {
    return {
      addedLines: Number(summary[1]),
      removedLines: Number(summary[2]),
      partial: truncated || text.includes('…[diff truncated:'),
    };
  }
  // Serialized new-file writes carry `+++ path` + `+ (new file, N lines)` and
  // NO `--- ` half, so the unified-diff anchor below never fires for them —
  // parse the marker first or a historical creation call stays unmeasured
  // even when the preview names the exact size.
  if (name === 'write') {
    const created = /\n\+\+\+ [^\n]+\n\+ \(new file, (\d+) lines\)/.exec(text);
    if (created) {
      return {
        addedLines: Number(created[1]),
        removedLines: 0,
        partial: truncated || text.includes('…[diff truncated:'),
      };
    }
  }
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i]!.startsWith('--- ') && lines[i + 1]!.startsWith('+++ ')) {
      start = i;
      break;
    }
  }
  const counted = countVisibleDeltas(lines, start);
  if (counted === undefined) {
    // No-op edits and identical overwrites serialize no diff at all — a
    // WHOLE preview without one measured nothing and stays "—". A TRUNCATED
    // preview that kept the mutating header but lost the diff still proves
    // the call changed the file, so credit it as a zero-count partial
    // instead: a silent "—" would read as "never measured".
    if (truncated && mutatingCall(name, text))
      return { addedLines: 0, removedLines: 0, partial: true };
    return undefined;
  }
  if (!counted.addedLines && !counted.removedLines && !truncated) return undefined;
  return {
    addedLines: counted.addedLines,
    removedLines: counted.removedLines,
    partial: truncated || text.includes('…[diff truncated:'),
  };
}

/** Count `+`/`-` lines inside `@@` hunks from the diff header on; undefined when no diff is present. */
function countVisibleDeltas(
  lines: string[],
  start: number,
): { addedLines: number; removedLines: number } | undefined {
  if (start === -1) return undefined;
  let addedLines = 0;
  let removedLines = 0;
  let inHunk = false;
  for (const line of lines.slice(start)) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) addedLines++;
    else if (line.startsWith('-')) removedLines++;
  }
  return { addedLines, removedLines };
}

/** The serialized header names what the call did: a mutating header proves the file changed. */
function mutatingCall(name: string, text: string): boolean {
  if (name === 'edit') return /replacements=[1-9]/.test(text);
  return /created=true|bytes_written=[1-9]/.test(text) && !/no-op/i.test(text);
}

/**
 * Credit the files a FAILED call had already changed on disk.
 *
 * `tool.failed` carries `modifiedPaths` only when the tool verified the write
 * (a `patch --merge` that wrote conflict markers and then threw). Rows are
 * created or flagged but never counted: a failed call yields no line evidence,
 * and the damage is the whole point — so the UI labels these rows rather than
 * showing numbers that were never measured.
 */
function markConflicted(
  files: Map<string, FileRow>,
  call: { end?: { raw?: { attributes?: Record<string, unknown> | undefined } | undefined } },
  normalize: (path: string) => string,
  projectRoot: string,
): boolean {
  const attributes = call.end?.raw?.attributes;
  const modified = attributes?.modifiedPaths;
  if (!Array.isArray(modified)) return false;
  for (const entry of modified) {
    if (typeof entry !== 'string' || !entry) continue;
    const path = normalize(entry);
    const key = /^[a-z]:/i.test(projectRoot || entry) ? path.toLowerCase() : path;
    const existing = files.get(key);
    if (existing) {
      existing.conflicted = true;
      continue;
    }
    files.set(key, {
      path,
      reads: 0,
      edits: 0,
      writes: 0,
      readLines: 0,
      added: 0,
      removed: 0,
      readMeasured: 0,
      changeMeasured: 0,
      partial: false,
      conflicted: true,
    });
  }
  // The chronicle caps this list; the flag says files were dropped, so the
  // rows below are a lower bound on the damage, not a complete manifest.
  return attributes?.modifiedPathsTruncated === true;
}

/**
 * Credit a successful `patch` call to each file its diff touched.
 *
 * A patch is not path-scoped: `Tool.writeTargets` reports several targets for
 * one call and the chronicle record carries no single `resource.path`, so the
 * per-file deltas persisted by `fileToolStats` are the only attribution source.
 * Rows are created on demand — a patched file need never appear in
 * `story.files`, and skipping unknown paths is exactly what hid patch edits
 * from this tab in the first place.
 */
function attributePatch(
  files: Map<string, FileRow>,
  call: { end?: { raw?: { attributes?: Record<string, unknown> | undefined } | undefined } },
  normalize: (path: string) => string,
  projectRoot: string,
): void {
  const stats = call.end?.raw?.attributes?.fileStats;
  if (!stats || typeof stats !== 'object') return;
  const patchFiles = (stats as Record<string, unknown>).patchFiles;
  if (!Array.isArray(patchFiles)) return;
  for (const entry of patchFiles) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const rawPath = typeof row.path === 'string' ? row.path : '';
    if (!rawPath) continue;
    const added = typeof row.addedLines === 'number' ? row.addedLines : undefined;
    const removed = typeof row.removedLines === 'number' ? row.removedLines : undefined;
    if (added === undefined && removed === undefined) continue;
    const path = normalize(rawPath);
    const key = /^[a-z]:/i.test(projectRoot || rawPath) ? path.toLowerCase() : path;
    let file = files.get(key);
    if (!file) {
      file = {
        path,
        reads: 0,
        edits: 0,
        writes: 0,
        readLines: 0,
        added: 0,
        removed: 0,
        readMeasured: 0,
        changeMeasured: 0,
        partial: false,
        conflicted: false,
      };
      files.set(key, file);
    }
    file.edits++;
    if (added !== undefined) file.added += added;
    if (removed !== undefined) file.removed += removed;
    file.changeMeasured++;
  }
}
