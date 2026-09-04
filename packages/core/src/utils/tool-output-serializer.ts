/**
 * Tool output serialization utilities.
 * Extracted from Agent.executeTools to allow reuse and consistent output handling.
 */

export interface ToolOutputSerializerOptions {
  perIterationOutputCapBytes?: number | undefined;
  estimator?: ((text: string) => number) | undefined;
}

export interface ToolOutputSerializeContext {
  toolName?: string | undefined;
  input?: unknown;
  /**
   * Optional reference to the Tool object. When present and the tool defines
   * a `serialize()` method, the serializer delegates to it instead of the
   * central `renderToolObject()` switch (P3 #21).
   */
  tool?: { serialize?: (output: unknown, input: unknown) => string } | undefined;
}

type RecordValue = Record<string, unknown>;

const DEFAULT_LIST_LIMIT = 500;
const LOG_ENTRY_LIMIT = 200;
const INLINE_LIMIT = 240;
const GREP_FILE_LIMIT = 80;
const GREP_MATCHES_PER_FILE = 3;
const DIFF_INLINE_LINE_LIMIT = 260;
const DIFF_HUNK_LIMIT = 8;
const DIFF_HUNK_CONTEXT = 14;

// Pre-compiled regex — used in parseGrepContentLine() for every grep match line.
// Compiling once at module load avoids repeated RegExp construction overhead.
const GREP_LINE_RE = /^(.+?):(\d+):(.*)$/;

export function createToolOutputSerializer(opts: ToolOutputSerializerOptions = {}) {
  const capBytes = opts.perIterationOutputCapBytes ?? 100_000;

  function serialize(value: unknown, context: ToolOutputSerializeContext = {}): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      if (Array.isArray(value)) return value.map((item) => serialize(item)).join('\n');
      // P3 #21 (before-release.md): prefer the tool's own serialize() method
      // when it defines one — lets tools own their output formatting without
      // adding a branch to the central renderToolObject() god function.
      if (context.tool?.serialize) {
        try {
          return context.tool.serialize(value, context.input);
        } catch {
          // Fall through to the central renderer if the tool's serializer
          // throws — never let a formatting error break the tool result.
        }
      }
      if (context.toolName) {
        const compact = renderToolObject(context.toolName, value as RecordValue, context.input);
        if (compact !== undefined) return compact;
        return renderGenericToolObject(context.toolName, value as RecordValue);
      }
      if ('text' in (value as Record<string, unknown>)) {
        const t = (value as Record<string, unknown>).text;
        return typeof t === 'string' ? t : JSON.stringify(value, null, 2);
      }
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  function enforceCap(text: string, remainingBudget: number): { text: string; newBudget: number } {
    if (typeof text !== 'string') text = String(text ?? '');
    if (remainingBudget <= 0) {
      return { text: '[truncated: iteration output cap exceeded]', newBudget: 0 };
    }
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes <= remainingBudget) {
      return { text, newBudget: remainingBudget - textBytes };
    }
    const marker = `\n…[truncated ${textBytes - remainingBudget} bytes]…\n`;
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const available = remainingBudget - markerBytes;
    if (available <= 0) {
      return { text: '[truncated: iteration output cap exceeded]', newBudget: 0 };
    }
    const half = Math.floor(available / 2);
    const first = utf8Prefix(text, half);
    const second = utf8Suffix(text, available - Buffer.byteLength(first, 'utf8'));
    return { text: `${first}${marker}${second}`, newBudget: 0 };
  }

  return { serialize, enforceCap, capBytes };
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (typeof text !== 'string' || maxBytes <= 0) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (typeof text !== 'string' || maxBytes <= 0) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const chars = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(text.length - chars), 'utf8') <= maxBytes) low = chars;
    else high = chars - 1;
  }
  let start = text.length - low;
  if (start < text.length && /[\uDC00-\uDFFF]/.test(text[start]!)) start++;
  return text.slice(start);
}

function renderToolObject(toolName: string, obj: RecordValue, input: unknown): string | undefined {
  if (toolName === 'read' && typeof obj['text'] === 'string') {
    return joinSections([
      renderHeader(
        `read: ${stringFromInput(input, 'path') ?? stringField(obj, 'path') ?? '<unknown>'}`,
        {
          offset: numberFromInput(input, 'offset'),
          limit: numberFromInput(input, 'limit'),
          total_lines: obj['total_lines'],
          encoding: obj['encoding'],
          truncated: obj['truncated'],
          cached: obj['cached'],
          note: obj['note'],
        },
      ),
      obj['text'],
    ]);
  }

  if (toolName === 'grep' && Array.isArray(obj['matches'])) {
    const matches = stringArrayField(obj, 'matches');
    return joinSections([
      renderHeader(`grep: ${stringFromInput(input, 'pattern') ?? '<pattern>'}`, {
        path: stringFromInput(input, 'path'),
        glob: stringFromInput(input, 'glob'),
        mode: stringFromInput(input, 'output_mode'),
        count: obj['count'],
        shown: matches.length,
        truncated: obj['truncated'],
        used: obj['used'],
      }),
      renderGrepMatches(matches, stringFromInput(input, 'output_mode')),
    ]);
  }

  if (toolName === 'patch' && Array.isArray(obj['files'])) {
    const files = stringArrayField(obj, 'files');
    return joinSections([
      renderHeader('patch', {
        applied: obj['applied'],
        rejected: obj['rejected'],
        files: files.length,
        dry_run: obj['dry_run'],
      }),
      typeof obj['message'] === 'string' ? `message:\n${obj['message']}` : undefined,
      files.length > 0 ? `files:\n${renderStringList(files)}` : undefined,
    ]);
  }

  if (toolName === 'glob' && Array.isArray(obj['files'])) {
    const files = stringArrayField(obj, 'files');
    return joinSections([
      renderHeader(
        `${toolName}: ${stringFromInput(input, 'pattern') ?? stringFromInput(input, 'files') ?? stringFromInput(input, 'path') ?? ''}`.trim(),
        {
          path: stringFromInput(input, 'path'),
          files: files.length,
          truncated: obj['truncated'],
        },
      ),
      renderStringList(files, '(no files)'),
    ]);
  }

  if (toolName === 'tree' && typeof obj['tree'] === 'string') {
    return joinSections([
      renderHeader(
        `tree: ${stringField(obj, 'path') ?? stringFromInput(input, 'path') ?? '<cwd>'}`,
        {
          total_files: obj['total_files'],
          total_dirs: obj['total_dirs'],
          truncated: obj['truncated'],
        },
      ),
      obj['tree'],
    ]);
  }

  if (toolName === 'fetch' && typeof obj['content'] === 'string') {
    return joinSections([
      renderHeader(
        `fetch: ${stringField(obj, 'url') ?? stringFromInput(input, 'url') ?? '<url>'}`,
        {
          status: obj['status'],
          content_type: obj['content_type'],
        },
      ),
      obj['content'],
    ]);
  }

  if (toolName === 'replace' && Array.isArray(obj['results'])) {
    const results = obj['results'].filter(isRecord);
    const sections: Array<string | undefined> = [
      renderHeader('replace', {
        files_modified: obj['files_modified'],
        total_replacements: obj['total_replacements'],
        dry_run: obj['dry_run'],
      }),
    ];
    for (const r of results.slice(0, DEFAULT_LIST_LIMIT)) {
      sections.push(
        joinSections([
          renderHeader(`file: ${stringField(r, 'path') ?? '<unknown>'}`, {
            replacements: r['replacements'],
          }),
          typeof r['diff'] === 'string' ? r['diff'] : undefined,
        ]),
      );
    }
    if (results.length > DEFAULT_LIST_LIMIT) {
      sections.push(`[serializer omitted ${results.length - DEFAULT_LIST_LIMIT} result item(s)]`);
    }
    return joinSections(sections);
  }

  if (typeof obj['diff'] === 'string') {
    const diff = obj['diff'];
    // matched_by: 'exact' is the default and carries no information — only
    // surface the field when a fallback tier actually fired.
    const matchedBy =
      typeof obj['matched_by'] === 'string' && obj['matched_by'] !== 'exact'
        ? obj['matched_by']
        : undefined;
    const syntaxErrors = Array.isArray(obj['syntax_errors'])
      ? obj['syntax_errors'].filter((e): e is string => typeof e === 'string')
      : [];
    return joinSections([
      renderHeader(toolName, {
        path: obj['path'],
        replacements: obj['replacements'],
        bytes_written: obj['bytes_written'],
        created: obj['created'],
        matched_by: matchedBy,
        note: obj['note'],
        files: Array.isArray(obj['files']) ? obj['files'].length : undefined,
        truncated: obj['truncated'],
        mode: obj['mode'],
      }),
      compactDiff(diff),
      syntaxErrors.length > 0 ? `syntax_errors:\n${renderStringList(syntaxErrors)}` : undefined,
    ]);
  }

  if (toolName === 'test' && typeof obj['output'] === 'string') {
    return renderTestOutput(obj, input);
  }

  if (
    (toolName === 'typecheck' || toolName === 'lint' || toolName === 'format') &&
    typeof obj['output'] === 'string'
  ) {
    return renderVerifierOutput(toolName, obj, input);
  }

  if (hasCommandOutputShape(obj)) {
    return renderCommandOutput(toolName, obj, input);
  }

  if (toolName === 'json' && typeof obj['formatted'] === 'string') {
    return joinSections([
      renderHeader('json', {
        type: obj['type'],
        keys: Array.isArray(obj['keys']) ? obj['keys'].length : undefined,
        query: stringFromInput(input, 'query'),
        error: obj['error'],
      }),
      obj['formatted'],
    ]);
  }

  if (toolName === 'logs' && Array.isArray(obj['entries'])) {
    const entries = obj['entries'].filter(isRecord);
    const lines = entries.slice(0, LOG_ENTRY_LIMIT).map((entry) => {
      const ts = stringField(entry, 'timestamp') ?? '';
      const level = stringField(entry, 'level') ?? 'info';
      const message = stringField(entry, 'message') ?? '';
      const source = stringField(entry, 'source');
      return [ts, level, source, message].filter(Boolean).join(' ');
    });
    if (entries.length > LOG_ENTRY_LIMIT) {
      lines.push(`[serializer omitted ${entries.length - LOG_ENTRY_LIMIT} log entry item(s)]`);
    }
    return joinSections([
      renderHeader(`logs: ${stringField(obj, 'source') ?? '<source>'}`, {
        total: obj['total'],
        shown: Math.min(entries.length, LOG_ENTRY_LIMIT),
        truncated: obj['truncated'],
        stream_mode: obj['stream_mode'],
      }),
      lines.length > 0 ? lines.join('\n') : '(no log entries)',
    ]);
  }

  if (toolName === 'audit' && Array.isArray(obj['vulnerabilities'])) {
    const vulns = obj['vulnerabilities'].filter(isRecord);
    const lines = vulns.slice(0, DEFAULT_LIST_LIMIT).map((v) => {
      const severity = stringField(v, 'severity') ?? 'unknown';
      const pkg = stringField(v, 'package') ?? '<package>';
      const title = stringField(v, 'title') ?? '';
      const url = stringField(v, 'url');
      return [severity, pkg, title, url].filter(Boolean).join(' | ');
    });
    if (vulns.length > DEFAULT_LIST_LIMIT) {
      lines.push(`[serializer omitted ${vulns.length - DEFAULT_LIST_LIMIT} vulnerability item(s)]`);
    }
    return joinSections([
      renderHeader('audit', {
        exit_code: obj['exit_code'],
        total: obj['total'],
        summary: obj['summary'],
        truncated: obj['truncated'],
      }),
      lines.length > 0 ? lines.join('\n') : stringField(obj, 'output'),
    ]);
  }

  if (toolName === 'outdated' && Array.isArray(obj['packages'])) {
    const packages = obj['packages'].filter(isRecord);
    const lines = packages
      .slice(0, DEFAULT_LIST_LIMIT)
      .map((p) =>
        [
          stringField(p, 'name') ?? '<package>',
          `current=${stringField(p, 'current') ?? 'unknown'}`,
          `wanted=${stringField(p, 'wanted') ?? 'unknown'}`,
          `latest=${stringField(p, 'latest') ?? 'unknown'}`,
          stringField(p, 'type'),
        ]
          .filter(Boolean)
          .join(' | '),
      );
    if (packages.length > DEFAULT_LIST_LIMIT) {
      lines.push(`[serializer omitted ${packages.length - DEFAULT_LIST_LIMIT} package item(s)]`);
    }
    return joinSections([
      renderHeader('outdated', {
        exit_code: obj['exit_code'],
        total: obj['total'],
        truncated: obj['truncated'],
      }),
      lines.length > 0 ? lines.join('\n') : stringField(obj, 'output'),
    ]);
  }

  return undefined;
}

function renderTestOutput(obj: RecordValue, input: unknown): string {
  const exitCode = numberField(obj, 'exit_code') ?? 0;
  const failed = numberField(obj, 'failed') ?? 0;
  const output = stringField(obj, 'output') ?? '';
  const header = renderHeader(`test: ${stringField(obj, 'runner') ?? 'runner'}`, {
    exit_code: obj['exit_code'],
    tests_run: obj['tests_run'],
    passed: obj['passed'],
    failed: obj['failed'],
    duration_ms: obj['duration_ms'],
    truncated: obj['truncated'],
    files: inputListSummary(input, 'files'),
    grep: stringFromInput(input, 'grep'),
  });

  if (exitCode === 0 && failed === 0) {
    return joinSections([
      header,
      joinSections([
        'report:',
        `status=passed`,
        `tests_run=${obj['tests_run'] ?? 0}`,
        `passed=${obj['passed'] ?? 0}`,
        `failed=${obj['failed'] ?? 0}`,
        `duration_ms=${obj['duration_ms'] ?? 0}`,
        extractSpoolNote(output),
      ]),
    ]);
  }

  return joinSections([
    header,
    `error_context:\n${compactFailureOutput(output || '(no runner output)')}`,
  ]);
}

function renderVerifierOutput(toolName: string, obj: RecordValue, input: unknown): string {
  const exitCode = numberField(obj, 'exit_code') ?? 0;
  const errors = numberField(obj, 'errors') ?? 0;
  const warnings = numberField(obj, 'warnings') ?? 0;
  const output = stringField(obj, 'output') ?? '';
  const changed = numberField(obj, 'files_changed') ?? 0;
  const header = renderHeader(toolName, {
    exit_code: obj['exit_code'],
    errors: obj['errors'],
    warnings: obj['warnings'],
    files_checked: obj['files_checked'],
    files_changed: obj['files_changed'],
    fix_applied: obj['fix_applied'],
    fixer: obj['fixer'],
    linter: obj['linter'],
    project: obj['project'],
    truncated: obj['truncated'],
    files: inputListSummary(input, 'files'),
    cwd: stringFromInput(input, 'cwd'),
  });

  if (exitCode === 0 && errors === 0 && (toolName !== 'format' || changed === 0)) {
    return joinSections([
      header,
      joinSections([
        'report:',
        'status=passed',
        `errors=${errors}`,
        `warnings=${warnings}`,
        toolName === 'format' ? `files_changed=${changed}` : undefined,
        extractSpoolNote(output),
      ]),
    ]);
  }

  if (exitCode === 0 && toolName === 'format') {
    return joinSections([
      header,
      joinSections([
        'report:',
        'status=changed',
        `files_changed=${changed}`,
        extractSpoolNote(output),
      ]),
    ]);
  }

  return joinSections([
    header,
    `error_context:\n${compactFailureOutput(output || '(no verifier output)')}`,
  ]);
}

function renderGrepMatches(matches: string[], mode: string | undefined): string {
  if (matches.length === 0) return '(no matches)';
  if (mode === 'files_with_matches') return renderStringList(matches, '(no files)');
  if (mode === 'count') return renderStringList(matches, '(no counts)');

  const groups = new Map<string, string[]>();
  const passthrough: string[] = [];
  for (const match of matches) {
    const parsed = parseGrepContentLine(match);
    if (!parsed) {
      passthrough.push(match);
      continue;
    }
    const list = groups.get(parsed.file) ?? [];
    list.push(`${parsed.line}:${parsed.text}`);
    groups.set(parsed.file, list);
  }

  if (groups.size === 0) return renderStringList(matches, '(no matches)');

  const sections: string[] = [];
  let fileIndex = 0;
  for (const [file, lines] of groups) {
    fileIndex++;
    if (fileIndex > GREP_FILE_LIMIT) break;
    const shown = lines.slice(0, GREP_MATCHES_PER_FILE);
    sections.push(
      `${file} (${lines.length} match(es), showing ${shown.length})\n${shown.join('\n')}`,
    );
  }
  if (groups.size > GREP_FILE_LIMIT) {
    sections.push(`[serializer omitted ${groups.size - GREP_FILE_LIMIT} file group(s)]`);
  }
  if (passthrough.length > 0) {
    sections.push(`ungrouped:\n${renderStringList(passthrough, '', 50)}`);
  }
  return sections.join('\n');
}

function parseGrepContentLine(
  line: string,
): { file: string; line: string; text: string } | undefined {
  const match = GREP_LINE_RE.exec(line);
  if (!match?.[1] || !match[2]) return undefined;
  return { file: match[1], line: match[2], text: match[3] ?? '' };
}

function compactDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  if (lines.length <= DIFF_INLINE_LINE_LIMIT) return diff;

  const fileCount = Math.max(
    new Set(
      lines
        .map(
          (line) => /^diff --git\s+a\/(.+?)\s+b\//.exec(line)?.[1] ?? /^---\s+(.+)/.exec(line)?.[1],
        )
        .filter(Boolean),
    ).size,
    0,
  );
  const hunks = lines.filter((line) => line.startsWith('@@')).length;
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;

  // Collect [start, end] intervals as we scan lines sequentially.
  // Intervals are naturally ordered by line index — no sort needed.
  const intervals: Array<[number, number]> = [];
  let hunkCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      intervals.push([i, i]);
      continue;
    }
    if (!line.startsWith('@@')) continue;
    if (hunkCount >= DIFF_HUNK_LIMIT) continue;
    hunkCount++;
    intervals.push([i, Math.min(lines.length - 1, i + DIFF_HUNK_CONTEXT)]);
  }

  if (intervals.length === 0) {
    return joinSections([
      renderHeader('diff_summary', {
        files: fileCount,
        hunks,
        added,
        removed,
        lines: lines.length,
      }),
      lines.slice(0, DIFF_INLINE_LINE_LIMIT).join('\n'),
      `[serializer omitted ${Math.max(0, lines.length - DIFF_INLINE_LINE_LIMIT)} diff line(s)]`,
    ]);
  }

  // Merge overlapping / adjacent intervals in a single O(n) pass.
  // Intervals are already in ascending order from the sequential scan.
  const merged: Array<[number, number]> = [intervals[0]!];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1]!;
    const current = intervals[i]!;
    if (current[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }

  // Build excerpt from merged intervals — O(n), no sort.
  const excerpt: string[] = [];
  let prevLine = -1;
  for (const [start, end] of merged) {
    if (start > prevLine + 1) {
      const omitted = prevLine === -1 ? start : start - prevLine - 1;
      excerpt.push(`[serializer omitted ${omitted} diff line(s)]`);
    }
    for (let j = start; j <= end; j++) {
      excerpt.push(lines[j] ?? '');
    }
    prevLine = end;
  }

  const trailing = lines.length - prevLine - 1;
  if (trailing > 0) excerpt.push(`[serializer omitted ${trailing} trailing diff line(s)]`);

  return joinSections([
    renderHeader('diff_summary', {
      files: fileCount,
      hunks,
      shown_hunks: Math.min(hunks, DIFF_HUNK_LIMIT),
      added,
      removed,
      lines: lines.length,
    }),
    excerpt.join('\n'),
  ]);
}

function compactFailureOutput(output: string): string {
  const lines = output.split(/\r?\n/);
  if (lines.length <= 260) return output.trimEnd();

  const selected = new Set<number>();
  const marker =
    /\b(fail|failed|failure|error|exception|assertionerror|expected|received|actual|timeout|stack)\b/i;
  let markerHits = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!marker.test(lines[i] ?? '')) continue;
    markerHits++;
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 10); j++) {
      selected.add(j);
    }
  }

  if (markerHits === 0) {
    return lines.slice(-220).join('\n').trimEnd();
  }

  const ordered = [...selected].sort((a, b) => a - b);
  const out: string[] = [];
  let previous = -1;
  for (const index of ordered) {
    if (index > previous + 1) {
      const omitted = previous === -1 ? index : index - previous - 1;
      out.push(`[serializer omitted ${omitted} line(s)]`);
    }
    out.push(lines[index] ?? '');
    previous = index;
  }
  return out.join('\n').trimEnd();
}

function extractSpoolNote(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .find((line) => line.startsWith('[output truncated') && line.includes('full'));
}

function hasCommandOutputShape(obj: RecordValue): boolean {
  return (
    typeof obj['stdout'] === 'string' ||
    typeof obj['stderr'] === 'string' ||
    typeof obj['output'] === 'string' ||
    typeof obj['exitCode'] === 'number' ||
    typeof obj['exit_code'] === 'number'
  );
}

function renderCommandOutput(toolName: string, obj: RecordValue, input: unknown): string {
  const command = stringField(obj, 'command') ?? stringFromInput(input, 'command');
  const args = stringArrayField(obj, 'args');
  const commandLine = command ? [command, ...args].join(' ') : undefined;
  const output = stringField(obj, 'output');
  const stdout = stringField(obj, 'stdout');
  const stderr = stringField(obj, 'stderr');
  return joinSections([
    renderHeader(commandLine ? `${toolName}: ${commandLine}` : toolName, {
      exit_code: obj['exit_code'] ?? obj['exitCode'],
      timed_out: obj['timed_out'],
      pid: obj['pid'],
      allowed: obj['allowed'],
      truncated: obj['truncated'],
      runner: obj['runner'],
      linter: obj['linter'],
      fixer: obj['fixer'],
      project: obj['project'],
      tests_run: obj['tests_run'],
      passed: obj['passed'],
      failed: obj['failed'],
      duration_ms: obj['duration_ms'],
      errors: obj['errors'],
      warnings: obj['warnings'],
      files_checked: obj['files_checked'],
      files_changed: obj['files_changed'],
      fix_applied: obj['fix_applied'],
    }),
    stringField(obj, 'error') ? `error:\n${stringField(obj, 'error')}` : undefined,
    output ? `output:\n${output}` : undefined,
    stdout ? `stdout:\n${stdout}` : undefined,
    stderr ? `stderr:\n${stderr}` : undefined,
  ]);
}

function renderGenericToolObject(toolName: string, obj: RecordValue): string {
  const scalars: RecordValue = {};
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (isScalar(value)) {
      const inline = String(value);
      if (inline.length <= INLINE_LIMIT && !inline.includes('\n')) {
        scalars[key] = value;
      } else {
        blocks.push(`${key}:\n${inline}`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string')) {
        blocks.push(`${key}:\n${renderStringList(value as string[])}`);
      } else {
        blocks.push(`${key}:\n${renderUnknownList(value)}`);
      }
      continue;
    }
    blocks.push(`${key}: ${clipInline(oneLineJson(value))}`);
  }
  return joinSections([renderHeader(toolName, scalars), ...blocks]);
}

function renderHeader(label: string, fields: RecordValue): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${clipInline(formatInlineValue(value))}`);
  return parts.length > 0 ? `${label} (${parts.join(' ')})` : label;
}

function renderStringList(items: string[], empty = '', limit = DEFAULT_LIST_LIMIT): string {
  if (items.length === 0) return empty;
  const shown = items.slice(0, limit);
  const omitted = items.length - shown.length;
  return [
    ...shown,
    ...(omitted > 0
      ? [`[serializer omitted ${omitted} item(s); narrow the request for more]`]
      : []),
  ].join('\n');
}

function renderUnknownList(items: unknown[], limit = DEFAULT_LIST_LIMIT): string {
  const shown = items.slice(0, limit).map((item) => clipInline(oneLineJson(item), 1_000));
  const omitted = items.length - shown.length;
  if (omitted > 0)
    shown.push(`[serializer omitted ${omitted} item(s); narrow the request for more]`);
  return shown.join('\n');
}

function joinSections(sections: Array<string | undefined>): string {
  return sections
    .map((section) => (typeof section === 'string' ? section.trimEnd() : undefined))
    .filter((section): section is string => !!section)
    .join('\n');
}

function formatInlineValue(value: unknown): string {
  /* v8 ignore next -- no renderHeader field is ever an array (all callers pass scalars) */
  if (Array.isArray(value)) return `[${value.map(formatInlineValue).join(',')}]`;
  if (isScalar(value)) return String(value);
  return oneLineJson(value);
}

function clipInline(value: string, max = INLINE_LIMIT): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max
    ? compact
    : `${compact.slice(0, max - 15)}...(${compact.length} chars)`;
}

function oneLineJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringField(obj: RecordValue, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(obj: RecordValue, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

function stringArrayField(obj: RecordValue, key: string): string[] {
  const value = obj[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringFromInput(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function numberFromInput(input: unknown, key: string): number | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

function inputListSummary(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(',');
  return undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * Render a tool result body for inclusion in the `tool.executed` event.
 * Tool outputs can be large (file dumps, command output); UIs only want a
 * preview line, so cap at ~400 chars with an ellipsis marker.
 */
export function truncateForEvent(content: string, max = 400): string {
  if (!content) return '';
  return content.length <= max ? content : `${content.slice(0, max - 1)}…`;
}

/**
 * Derive size signals (bytes / tokens / lines) for the chip rendered beside
 * each tool result. Computed once over the FULL `content` BEFORE the
 * 400-char event preview is taken.
 *
 *  - bytes: UTF-8 byte length (multi-byte aware).
 *  - tokens: standard ~3.5 chars/token heuristic.
 *  - lines: read prefixes lines with `<n>→`; for shell/grep/logs we fall
 *    back to a newline count. Undefined for tools without a line notion.
 */
const READ_LINE_PREFIX_RE = /^\s*\d+→/gm;

export function sizeSignals(
  toolName: string | undefined,
  content: string,
): { outputBytes: number; outputTokens: number; outputLines: number | undefined } {
  if (!content || content.length === 0) {
    return { outputBytes: 0, outputTokens: 0, outputLines: undefined };
  }
  const outputBytes = Buffer.byteLength(content, 'utf8');
  const outputTokens = Math.max(1, Math.round(outputBytes / 3.5));
  let outputLines: number | undefined;
  if (toolName === 'read') {
    READ_LINE_PREFIX_RE.lastIndex = 0;
    let count = 0;
    while (READ_LINE_PREFIX_RE.exec(content) !== null) count++;
    if (count > 0) outputLines = count;
  } else if (
    toolName === 'bash' ||
    toolName === 'shell' ||
    toolName === 'grep' ||
    toolName === 'logs'
  ) {
    let nl = 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) nl++;
    outputLines = nl + (content.endsWith('\n') ? 0 : 1);
  }
  return { outputBytes, outputTokens, outputLines };
}
