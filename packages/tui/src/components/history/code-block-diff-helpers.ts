import { stringOf, tryParseJson } from './utils.js';

interface ReplaceDiffItem {
  path?: string | undefined;
  diff: string;
}

interface PathedDiffItem {
  path?: string | undefined;
  diff: string;
}

interface DiffBlockSplit {
  path?: string | undefined;
  diff: string;
}

export function joinReplaceDiffs(obj: Record<string, unknown>): string | undefined {
  const items = splitReplaceDiffs(obj);
  const diffs = items.map((item) => item.diff);
  return diffs.length > 0 ? diffs.join('\n') : undefined;
}

function splitReplaceDiffs(obj: Record<string, unknown>): ReplaceDiffItem[] {
  const results = Array.isArray(obj['results']) ? (obj['results'] as unknown[]) : [];
  const items: ReplaceDiffItem[] = [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const record = result as Record<string, unknown>;
    const diff = stringOf(record['diff']);
    if (!diff?.trim()) continue;
    const path = stringOf(record['path']);
    items.push(path ? { path, diff } : { diff });
  }
  return items;
}

export function countUnifiedDiffChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let lineStart = 0;
  const startsWithAny = (prefixes: string[], end: number): string | undefined =>
    prefixes.find((p) => end - lineStart >= p.length && diff.startsWith(p, lineStart));

  const processLine = (end: number): void => {
    const found = startsWithAny(['diff --git ', '@@'], end);
    if (found === 'diff --git ') {
      /* outside hunk - reset is implicit via the next @@ */
    } else if (found === '@@') {
      /* entering hunk */
    } else {
      const first = diff.charCodeAt(lineStart);
      const fileHeader = startsWithAny(['+++ ', '--- '], end) !== undefined;
      if (!fileHeader && first === 43) added++;
      else if (!fileHeader && first === 45) removed++;
    }
  };

  for (let index = 0; index < diff.length; index++) {
    if (diff.charCodeAt(index) !== 10) continue;
    processLine(index);
    lineStart = index + 1;
  }
  // Process the unterminated final line (no trailing newline).
  if (lineStart < diff.length) processLine(diff.length);
  return { added, removed };
}

export function collectMultiFileDiffItems(
  toolName: string,
  output: string,
  // `input` is reserved for future per-tool fallbacks (e.g. `replace` paths
  // derived from the input shape). The current dispatch derives paths from
  // the tool output itself (`files: string[]` from `diff`/`patch`,
  // `results[i].path` from `replace`, header lines from raw patches), so the
  // parameter is intentionally unused here. Marking it `_input` keeps the
  // surface stable for callers without triggering TS6133.
  _input?: unknown | undefined,
): PathedDiffItem[] | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;

  if (toolName === 'replace') {
    const parsed = tryParseJson(trimmed);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const items = splitReplaceDiffs(parsed as Record<string, unknown>);
    if (items.length === 0) return items;
    // Fallback: if every result omitted its own path, use the input's
    // `path` argument as the shared label (matches the previous
    // `extractReplaceDiffs` behaviour).
    const allMissing = items.every((item) => !item.path);
    const fallback =
      allMissing &&
      _input &&
      typeof _input === 'object' &&
      typeof (_input as Record<string, unknown>)['path'] === 'string'
        ? stringOf((_input as Record<string, unknown>)['path'])
        : undefined;
    if (fallback) {
      return items.map((item) => ({ path: item.path ?? fallback, diff: item.diff }));
    }
    return items;
  }

  if (toolName === 'diff') {
    const parsed = tryParseJson(trimmed);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const files = Array.isArray(obj['files'])
        ? (obj['files'] as unknown[]).map(stringOf).filter((p): p is string => Boolean(p))
        : [];
      const diff = stringOf(obj['diff']) ?? stringOf(obj['stdout']);
      if (!diff?.trim()) return undefined;
      // If `files` is populated, pair it with the (possibly multi-file)
      // diff by splitting the diff on `diff --git` headers and using the
      // `files` list as the preferred path source (left-to-right). When
      // the lengths disagree (e.g. empty `files`, or a diff that contains
      // more blocks than the count suggests), fall back to the path parsed
      // from the diff headers.
      const blocks = splitGitStyleDiff(diff);
      return blocks.map((block, idx) => ({
        path: files[idx] ?? block.path,
        diff: block.diff,
      }));
    }
    // Non-JSON `diff` output - treat the whole blob as one block, no path.
    if (trimmed.includes('@@')) return [{ diff: trimmed }];
    return undefined;
  }

  if (toolName === 'patch') {
    const parsed = tryParseJson(trimmed);
    let diffText: string | undefined;
    let explicitFiles: string[] = [];
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      diffText = stringOf(obj['diff']) ?? stringOf(obj['stdout']);
      if (Array.isArray(obj['files'])) {
        explicitFiles = (obj['files'] as unknown[])
          .map(stringOf)
          .filter((p): p is string => Boolean(p));
      }
    } else if (trimmed.includes('@@') || trimmed.startsWith('---')) {
      diffText = trimmed;
    }
    if (!diffText?.trim()) return undefined;
    const blocks = splitGitStyleDiff(diffText);
    if (blocks.length === 0) {
      // A patch with no `diff --git` headers but valid `---`/`+++`
      // headers is single-file - wrap it as one block, taking the path
      // from the explicit `files` array if available.
      const path = explicitFiles[0] ?? extractPatchHeaderPath(diffText);
      return [{ path, diff: diffText }];
    }
    return blocks.map((block, idx) => ({
      path: explicitFiles[idx] ?? block.path,
      diff: block.diff,
    }));
  }

  return undefined;
}

/**
 * Recover the unified-diff body from a serialized tool-output string.
 *
 * The tool-output serializer renders edit/diff/write results as a header
 * line (e.g. `edit (path=...)`) followed by the raw unified diff. Feeding
 * the whole string to `parseUnifiedDiff` would mis-read the header as a
 * context line and skew the hunk line counters, so we slice from the first
 * genuine diff marker (`--- `, `diff --git`, or `@@`).
 */
export function extractUnifiedDiffText(text: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex(
    (line) =>
      // Real unified-diff `--- ` headers carry a file path, not a label like
      // `--- SAGE: ...`; reject uppercase-label patterns that hook notices
      // append to tool output after a blank-line separator.
      (line.startsWith('--- ') && !/^--- [A-Z]{2,}:/.test(line)) ||
      line.startsWith('diff --git') ||
      line.startsWith('@@'),
  );
  if (start === -1) return undefined;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.length === 0) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export function newFileDiffFromWriteInput(
  output: Record<string, unknown>,
  input: unknown,
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const content = stringOf(obj['content']);
  if (content === undefined) return undefined;
  const path = stringOf(output['path']) ?? stringOf(obj['path']) ?? 'new file';
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  const header = [`+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`];
  return [...header, ...lines.map((line) => `+${line}`)].join('\n');
}

/**
 * Split a concatenated git-style unified diff into per-file blocks.
 * Recognises both `diff --git a/<path> b/<path>` headers (the modern git
 * format, also produced by `git diff` and `git format-patch`) and the
 * older `--- a/<path> / +++ b/<path>` pair as a fallback when no
 * `diff --git` line is present. Returns an empty array if the input
 * doesn't look like a unified diff at all.
 */
function splitGitStyleDiff(diff: string): DiffBlockSplit[] {
  const lines = diff.split('\n');
  const blocks: DiffBlockSplit[] = [];
  let current: { path?: string | undefined; body: string[]; hasGitHeader: boolean } | null = null;

  const flush = (): void => {
    if (!current) return;
    const text = current.body.join('\n').trim();
    if (text) blocks.push({ path: current.path, diff: text });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = { path: parseDiffGitPath(line), body: [line], hasGitHeader: true };
      continue;
    }
    if (current) {
      current.body.push(line);
      // Treat `--- a/` as a block boundary only when the current block
      // has no `diff --git` header (older patch(1) format).
      if (!current.hasGitHeader && line.startsWith('--- a/') && current.body.length > 2) {
        const carriedBody = current.body.slice(0, -1);
        const carriedPath = current.path;
        const text = carriedBody.join('\n').trim();
        if (text) blocks.push({ path: carriedPath, diff: text });
        current = {
          path: line.slice('--- a/'.length).trim(),
          body: [line],
          hasGitHeader: false,
        };
      }
    } else if (line.startsWith('--- a/')) {
      current = { path: line.slice('--- a/'.length).trim(), body: [line], hasGitHeader: false };
    } else if (line.startsWith('+++ b/')) {
      // Lone +++ without a preceding --- - synthesise a block with no path.
      current = { body: [line], hasGitHeader: false };
    }
  }
  flush();

  // If we ended up with a single block and no path was parsed, try a
  // last-ditch read of the `+++ b/` line in the body.
  if (blocks.length === 1 && !blocks[0]!.path) {
    const path = extractPatchHeaderPath(blocks[0]!.diff);
    if (path) blocks[0] = { path, diff: blocks[0]!.diff };
  }

  return blocks;
}

function parseDiffGitPath(line: string): string | undefined {
  // `diff --git a/<path> b/<path>` - handle paths-with-spaces by splitting
  // on ` b/` from the right when possible, falling back to the simpler
  // split when there's no ambiguity.
  const rest = line.slice('diff --git '.length).trim();
  if (!rest) return undefined;
  const sep = rest.lastIndexOf(' b/');
  if (sep > 0 && sep > rest.length - sep - 3) {
    return rest.slice(sep + 3);
  }
  // Fallback: take the right-hand token after the last space, stripping
  // the leading `b/`.
  const spaceIdx = rest.lastIndexOf(' ');
  if (spaceIdx > 0) {
    const rhs = rest.slice(spaceIdx + 1);
    return rhs.startsWith('b/') ? rhs.slice(2) : rhs;
  }
  return undefined;
}

function extractPatchHeaderPath(diffText: string): string | undefined {
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      // `+++ b/<path>` is the git convention; `+++ <path>` is the patch(1)
      // convention. Strip a leading `b/` and any trailing timestamp.
      const cleaned = path.replace(/^b\//, '').split('\t')[0]!.trim();
      return cleaned || undefined;
    }
  }
  return undefined;
}
