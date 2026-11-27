import type { RecordValue } from './tool-output-compact.js';
import {
  compactDiff,
  compactFailureOutput,
  joinSections,
  renderHeader,
} from './tool-output-compact.js';

export type { RecordValue } from './tool-output-compact.js';
export {
  clipInline,
  compactDiff,
  compactFailureOutput,
  DIFF_HUNK_CONTEXT,
  DIFF_HUNK_LIMIT,
  DIFF_INLINE_LINE_LIMIT,
  formatInlineValue,
  INLINE_LIMIT,
  isScalar,
  joinSections,
  oneLineJson,
  renderHeader,
} from './tool-output-compact.js';

export const DEFAULT_LIST_LIMIT = 500;

export const LOG_ENTRY_LIMIT = 200;

export const GREP_FILE_LIMIT = 80;

export const GREP_MATCHES_PER_FILE = 3;

// Pre-compiled regex — used in parseGrepContentLine() for every grep match line.
// Compiling once at module load avoids repeated RegExp construction overhead.
export const GREP_LINE_RE = /^(.+?):(\d+):(.*)$/;

export function renderToolObject(
  toolName: string,
  obj: RecordValue,
  input: unknown,
): string | undefined {
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
    const mode = stringFromInput(input, 'output_mode');
    const contentMatchCount =
      mode === undefined || mode === 'content'
        ? matches.reduce((total, match) => total + (parseGrepContentLine(match) ? 1 : 0), 0)
        : undefined;
    return joinSections([
      renderHeader(`grep: ${stringFromInput(input, 'pattern') ?? '<pattern>'}`, {
        path: stringFromInput(input, 'path'),
        glob: stringFromInput(input, 'glob'),
        mode,
        // rg -C includes context records and `--` separators in its raw
        // count. For content output, report the actual visible hit records.
        count: contentMatchCount ?? obj['count'],
        shown: contentMatchCount ?? matches.length,
        truncated: obj['truncated'],
        used: obj['used'],
      }),
      renderGrepMatches(matches, mode),
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
        // Set only when the source was not strict JSON (jsonc / yaml).
        source_format: obj['source_format'],
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

export function renderTestOutput(obj: RecordValue, input: unknown): string {
  const exitCode = numberField(obj, 'exit_code');
  const failed = numberField(obj, 'failed') ?? 0;
  const output = stringField(obj, 'output') ?? '';
  const header = renderHeader(`test: ${stringField(obj, 'runner') ?? 'runner'}`, {
    status: obj['status'],
    exit_code: obj['exit_code'],
    tests_run: obj['tests_run'],
    passed: obj['passed'],
    failed: obj['failed'],
    duration_ms: obj['duration_ms'],
    truncated: obj['truncated'],
    files: inputListSummary(input, 'files'),
    grep: stringFromInput(input, 'grep'),
  });

  // "Nothing to run" must never be rendered as a pass (it used to fall into
  // the exit-0 branch below and read `status=passed`).
  if (stringField(obj, 'status') === 'no_tests') {
    return joinSections([
      header,
      joinSections(['report:', 'status=no_tests', output || 'No tests to run.']),
    ]);
  }

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

export function renderVerifierOutput(toolName: string, obj: RecordValue, input: unknown): string {
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
      // A passing run with warnings used to print only their COUNT: "warnings=2"
      // and no way to see which two short of re-running the linter in a shell.
      warnings > 0 && output.trim()
        ? `warning_context:\n${compactFailureOutput(output)}`
        : undefined,
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

export function renderGrepMatches(matches: string[], mode: string | undefined): string {
  if (matches.length === 0) return '(no matches)';
  if (mode === 'files_with_matches') return renderStringList(matches, '(no files)');
  if (mode === 'count') return renderStringList(matches, '(no counts)');

  const groups = new Map<string, Array<{ line: string; text: string; isMatch: boolean }>>();
  const passthrough: string[] = [];

  // ripgrep uses `file:line:text` for hits but `file-line-text` for context
  // emitted by -C. Discover hit files first so context can be associated
  // without ambiguously parsing hyphens in either file names or source text.
  for (const match of matches) {
    const parsed = parseGrepContentLine(match);
    if (parsed && !groups.has(parsed.file)) groups.set(parsed.file, []);
  }
  const knownFiles = [...groups.keys()].sort((a, b) => b.length - a.length);

  for (const match of matches) {
    const parsed = parseGrepContentLine(match);
    if (parsed) {
      groups.get(parsed.file)?.push({ line: parsed.line, text: parsed.text, isMatch: true });
      continue;
    }

    const context = parseGrepContextLine(match, knownFiles);
    if (context) {
      groups.get(context.file)?.push({ line: context.line, text: context.text, isMatch: false });
      continue;
    }

    // `rg -C` separates non-adjacent context blocks with this marker. Line
    // numbers already preserve that information, so forwarding it adds noise.
    if (match !== '--') passthrough.push(match);
  }

  if (groups.size === 0) return renderStringList(matches, '(no matches)');

  const sections: string[] = [];
  let fileIndex = 0;
  for (const [file, lines] of groups) {
    fileIndex++;
    if (fileIndex > GREP_FILE_LIMIT) break;
    const matchCount = lines.reduce((total, line) => total + (line.isMatch ? 1 : 0), 0);
    let seenMatches = 0;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]?.isMatch) continue;
      seenMatches++;
      if (seenMatches > GREP_MATCHES_PER_FILE) {
        end = i;
        break;
      }
    }
    const shown = lines.slice(0, end);
    const shownMatchCount = shown.reduce((total, line) => total + (line.isMatch ? 1 : 0), 0);
    sections.push(
      `${file} (${matchCount} match(es), showing ${shownMatchCount})\n${shown
        .map((line) => `${line.line}${line.isMatch ? ':' : '-'}${line.text}`)
        .join('\n')}`,
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

export function parseGrepContentLine(
  line: string,
): { file: string; line: string; text: string } | undefined {
  const match = GREP_LINE_RE.exec(line);
  if (!match?.[1] || !match[2]) return undefined;
  return { file: match[1], line: match[2], text: match[3] ?? '' };
}

export function parseGrepContextLine(
  value: string,
  knownFiles: string[],
): { file: string; line: string; text: string } | undefined {
  for (const file of knownFiles) {
    const prefix = `${file}-`;
    if (!value.startsWith(prefix)) continue;
    const match = /^(\d+)-(.*)$/.exec(value.slice(prefix.length));
    if (match?.[1]) return { file, line: match[1], text: match[2] ?? '' };
  }
  return undefined;
}

export function extractSpoolNote(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .find((line) => line.startsWith('[output truncated') && line.includes('full'));
}

export function hasCommandOutputShape(obj: RecordValue): boolean {
  return (
    typeof obj['stdout'] === 'string' ||
    typeof obj['stderr'] === 'string' ||
    typeof obj['output'] === 'string' ||
    typeof obj['exitCode'] === 'number' ||
    typeof obj['exit_code'] === 'number'
  );
}

export function renderCommandOutput(toolName: string, obj: RecordValue, input: unknown): string {
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
    // A background run's output goes to this file, not into the result.
    stringField(obj, 'log_file') ? `log_file: ${stringField(obj, 'log_file')}` : undefined,
    output ? `output:\n${output}` : undefined,
    stdout ? `stdout:\n${stdout}` : undefined,
    stderr ? `stderr:\n${stderr}` : undefined,
  ]);
}

export function renderStringList(items: string[], empty = '', limit = DEFAULT_LIST_LIMIT): string {
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

export function stringField(obj: RecordValue, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberField(obj: RecordValue, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

export function stringArrayField(obj: RecordValue, key: string): string[] {
  const value = obj[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function stringFromInput(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberFromInput(input: unknown, key: string): number | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

export function inputListSummary(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(',');
  return undefined;
}

export function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
