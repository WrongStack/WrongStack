export { countLines, firstNonEmpty, fmtBytes, fmtDuration, fmtTok, formatMatchHit, numOf, scanNumberedRange, shortenPath, stringOf, truncMid, tryParseJson } from './basic-format.js';
export {
  AssistantStreamBox,
  assistantStreamBoxHeight,
  MAX_STREAM_DISPLAY_CHARS,
  streamBoxRows,
  ToolStreamBox,
  tailForDisplay,
  toolStreamBoxHeight,
} from './stream-box.js';
export { ToolOutputLines } from './visual-lines.js';
export type { ToolVisualLine, ToolVisualLineKind } from './tool-visual-types.js';

import {
  countLines,
  firstNonEmpty,
  fmtBytes,
  fmtDuration,
  formatMatchHit,
  numOf,
  scanNumberedRange,
  shortenPath,
  stringOf,
  truncMid,
  tryParseJson,
} from './basic-format.js';
import {
  GENERIC_BUDGET,
  OUT_BUDGET,
  summarizeJsonObject,
} from './tool-output-summary.js';
import {
  appendOutputPreview,
  bodyLines,
  numberFromParsedField,
  parseHeaderLine,
  parseKeyValueLines,
  parseNamedSections,
} from './tool-visual-format.js';
import { visualCommand } from './tool-visual-command.js';
import {
  visualCodebase,
  visualDocument,
  visualMetaExecution,
  visualTodo,
  visualToolCatalog,
  visualWorkBoard,
} from './tool-visual-domain.js';
import { visualLsp } from './tool-visual-lsp.js';
import {
  visualAudit,
  visualFetch,
  visualJson,
  visualOutdated,
  visualScaffold,
} from './tool-visual-misc.js';
import { visualMode, visualWorkingDir } from './tool-visual-mode-workdir.js';
import { visualLogs, visualMemory } from './visual-memory-logs.js';
import { formatToolOutputSageWith } from './sage-output-format.js';
import type { ToolVisualLine, ToolVisualLineKind } from './tool-visual-types.js';

export { formatToolArgs } from './tool-arg-format.js';
export { extractSageBlock, resolveEntrySage, type SageSplit, parseSageMemoryLine, type ParsedSageMemoryLine } from './sage-output-format.js';

/**
 * Like `formatToolOutput` but strips SAGE-injected memory lines first.
 * Returns the tool output lines and any SAGE block lines separately.
 */
export function formatToolOutputSage(
  toolName: string,
  output: string | undefined,
  ok: boolean,
  outputBytes?: number | undefined,
  outputLines?: number | undefined,
  /** Structured SAGE lines from `tool.executed.sage`, when the entry has them. */
  sageLines?: readonly string[] | undefined,
): { cleanOutput: string; outLines: string[]; sageLines: string[] } {
  return formatToolOutputSageWith({
    toolName,
    output,
    ok,
    sageLines,
    outputBytes,
    outputLines,
    formatToolOutput,
  });
}

// ============================================
// Tool output formatting
// ============================================

/**
 * Distil a tool's result text into 0–N digest lines the renderer can stack.
 */
export function formatToolOutput(
  toolName: string,
  output: string | undefined,
  ok: boolean,
  _outputBytes?: number | undefined,
  outputLines?: number | undefined,
): string[] {
  if (!output) return ok ? [] : ['failed'];
  const text = output.trim();
  if (!text) return ok ? [] : ['failed'];

  const json = tryParseJson(text);

  if (toolName === 'write' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const bytes = numOf(o['bytes_written']) ?? numOf(o['bytes']);
    const created = o['created'] === true;
    const tag = created ? 'created' : 'updated';
    return bytes !== undefined ? [`${tag} · ${fmtBytes(bytes)}`] : [tag];
  }

  if (toolName === 'edit' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const reps = numOf(o['replacements']);
    if (reps !== undefined) return [`${reps} replacement${reps === 1 ? '' : 's'}`];
  }

  if (toolName === 'patch' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const applied = numOf(o['applied']);
    const rejected = numOf(o['rejected']);
    const files = Array.isArray(o['files']) ? (o['files'] as unknown[]) : undefined;
    const lines: string[] = [];
    if (applied !== undefined || rejected !== undefined) {
      const parts = [];
      if (applied !== undefined) parts.push(`${applied} applied`);
      if (rejected !== undefined && rejected > 0) parts.push(`${rejected} rejected`);
      lines.push(parts.join(' · '));
    }
    if (files && files.length > 0) {
      const first = stringOf(files[0]) ?? '';
      const more = files.length > 1 ? ` (+${files.length - 1})` : '';
      lines.push(`${shortenPath(first, 60)}${more}`);
    }
    if (lines.length > 0) return lines;
  }

  if (toolName === 'replace' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const files = numOf(o['files_modified']);
    const reps = numOf(o['total_replacements']);
    if (files !== undefined && reps !== undefined) {
      return [
        `${reps} replacement${reps === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`,
      ];
    }
  }

  // diff
  if (toolName === 'diff' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const diffFiles = Array.isArray(o['files']) ? (o['files'] as unknown[]) : undefined;
    const truncated = o['truncated'] === true;
    const mode = stringOf(o['mode']);
    const diff = stringOf(o['diff']);
    if (!diff) return [diffFiles && diffFiles.length === 0 ? 'no changes' : 'empty diff'];
    const head: string[] = [];
    if (mode) head.push(mode);
    if (diffFiles && diffFiles.length > 0)
      head.push(`${diffFiles.length} file${diffFiles.length === 1 ? '' : 's'}`);
    if (truncated) head.push('truncated');
    return head.length > 0 ? [head.join(' · ')] : [];
  }

  // read
  if (toolName === 'read') {
    if (outputLines !== undefined) return [];
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const bytes = numOf(o['bytes']);
      if (bytes !== undefined) return [`${fmtBytes(bytes)} read`];
    }
    const range = scanNumberedRange(text);
    if (range.count > 0 && range.first !== undefined && range.last !== undefined) {
      if (range.first === range.last) return [`L${range.first} · ${fmtBytes(text.length)}`];
      const contiguous = range.count === range.last - range.first + 1;
      const head = `L${range.first}–${range.last}`;
      const tail = contiguous
        ? `${range.count} line${range.count === 1 ? '' : 's'}`
        : `${range.count} lines (gaps)`;
      return [`${head} · ${tail} · ${fmtBytes(text.length)}`];
    }
  }

  // grep / glob
  if (toolName === 'grep' || toolName === 'glob') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const matches = Array.isArray(o['matches']) ? (o['matches'] as unknown[]) : undefined;
      const count = numOf(o['count']) ?? matches?.length;
      const truncated = o['truncated'] === true;
      if (count !== undefined) {
        if (count === 0) return ['no matches'];
        const lines: string[] = [
          `${count} match${count === 1 ? '' : 'es'}${truncated ? ' (truncated)' : ''}`,
        ];
        const firstHit = matches && matches.length > 0 ? formatMatchHit(matches[0]) : undefined;
        if (firstHit) lines.push(firstHit);
        return lines;
      }
    }
  }

  // bash / shell
  //
  // Command tools may report output as either stdout/stderr or output/error.
  // Support both shapes here so timeout chips, line counts, and previews do not
  // depend on which executor produced the result.
  if (toolName === 'bash' || toolName === 'shell') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
      const stdout = stringOf(o['stdout']) ?? stringOf(o['output']) ?? '';
      const stderr = stringOf(o['stderr']) ?? stringOf(o['error']) ?? '';
      const timedOut = o['timed_out'] === true || o['timedOut'] === true;
      const stdoutLines = countLines(stdout);
      const stderrLines = countLines(stderr);
      const head: string[] = [];
      if (exit !== undefined) head.push(`exit ${exit}`);
      if (timedOut) head.push('timed out');
      const lineParts: string[] = [];
      if (stdoutLines > 0) lineParts.push(`${stdoutLines} out`);
      if (stderrLines > 0) lineParts.push(`${stderrLines} err`);
      if (lineParts.length > 0) head.push(lineParts.join(' · '));
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      const stdoutPreview = firstNonEmpty(stdout);
      const stderrPreview = firstNonEmpty(stderr);
      if (stdoutPreview) lines.push(`"${truncMid(stdoutPreview, 70)}"`);
      if (stderrPreview && stderrPreview !== stdoutPreview) {
        lines.push(`! "${truncMid(stderrPreview, 70)}"`);
      }
      if (lines.length > 0) return lines;
    }
  }

  // exec (heuristic danger detection, PR 1-3)
  //
  // The exec tool's output is JSON with a `danger: { level, reasons, matchedRule? }`
  // field. When the level is destructive or caution we prefix the digest with
  // a compact chip-style banner so those calls are visually distinct from
  // safe ones. Safe calls (and output with no `danger` field) use the same
  // compact `exit N · X out · Y err` shape as the bash / git branches below,
  // so all three command-tool outputs read uniformly.
  //
  // Format:
  //   destructive:  ⚠ DESTRUCTIVE  recursive force-delete
  //                  exit 0 · 12 out · 0 err
  //                  "build/"
  //   caution:      ! CAUTION  inline script evaluation (-c / -e / --eval)
  //                  exit 0 · 0 out · 0 err
  //   safe:         exit 0 · 12 out · 0 err
  //                  "build/"
  //
  // The chip is plain-text so this is portable across TUI/webui/CLI
  // renderers; theme-tinting is up to the consumer.
  if (toolName === 'exec') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const danger = o['danger'];
      const level =
        danger && typeof danger === 'object'
          ? (danger as Record<string, unknown>)['level']
          : undefined;
      const reasons =
        danger && typeof danger === 'object'
          ? ((danger as Record<string, unknown>)['reasons'] as unknown)
          : undefined;
      const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
      const stdout = stringOf(o['stdout']) ?? '';
      const stderr = stringOf(o['stderr']) ?? '';
      const stdoutLines = countLines(stdout);
      const stderrLines = countLines(stderr);
      const head: string[] = [];
      if (level === 'destructive' || level === 'caution') {
        const chip = level === 'destructive' ? '⚠ DESTRUCTIVE' : '! CAUTION';
        const reasonText =
          Array.isArray(reasons) && reasons.length > 0
            ? String(reasons[0])
            : level === 'destructive'
              ? 'destructive command'
              : 'caution-level command';
        head.push(`${chip}  ${reasonText}`);
      }
      if (exit !== undefined) head.push(`exit ${exit}`);
      const lineParts: string[] = [];
      if (stdoutLines > 0) lineParts.push(`${stdoutLines} out`);
      if (stderrLines > 0) lineParts.push(`${stderrLines} err`);
      if (lineParts.length > 0) head.push(lineParts.join(' · '));
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      // Surface additional reasons (beyond the first) as a stacked list
      if (Array.isArray(reasons) && reasons.length > 1) {
        for (let i = 1; i < reasons.length; i++) {
          lines.push(`  · ${String(reasons[i])}`);
        }
      }
      const stdoutPreview = firstNonEmpty(stdout);
      const stderrPreview = firstNonEmpty(stderr);
      if (stdoutPreview) lines.push(`"${truncMid(stdoutPreview, 70)}"`);
      if (stderrPreview && stderrPreview !== stdoutPreview) {
        lines.push(`! "${truncMid(stderrPreview, 70)}"`);
      }
      if (lines.length > 0) return lines;
    }
  }

  // todo
  if (toolName === 'todo') return ok ? [] : [text.split('\n')[0] ?? ''];

  // fetch / webfetch
  if (toolName === 'fetch' || toolName === 'webfetch' || toolName === 'web_fetch') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const status = numOf(o['status']);
      const ct = stringOf(o['content_type']);
      const url = stringOf(o['url']);
      const content = stringOf(o['content']);
      const head: string[] = [];
      if (status !== undefined) head.push(`HTTP ${status}`);
      if (ct) head.push(ct.split(';')[0] ?? ct);
      if (content) head.push(fmtBytes(Buffer.byteLength(content, 'utf8')));
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      if (url && status !== undefined && (status < 200 || status >= 400)) {
        lines.push(shortenPath(url, 70));
      }
      if (lines.length > 0) return lines;
    }
  }

  // git
  if (toolName === 'git' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const exit = numOf(o['exitCode']) ?? numOf(o['exit_code']);
    const stdout = stringOf(o['stdout']) ?? '';
    const stderr = stringOf(o['stderr']) ?? '';
    const head: string[] = [];
    if (exit !== undefined) head.push(`exit ${exit}`);
    const stdoutLines = countLines(stdout);
    const stderrLines = countLines(stderr);
    const lparts: string[] = [];
    if (stdoutLines > 0) lparts.push(`${stdoutLines} out`);
    if (stderrLines > 0) lparts.push(`${stderrLines} err`);
    if (lparts.length > 0) head.push(lparts.join(' · '));
    const lines: string[] = [];
    if (head.length > 0) lines.push(head.join(' · '));
    const preview = firstNonEmpty(stdout) ?? firstNonEmpty(stderr);
    if (preview) lines.push(`"${truncMid(preview, 70)}"`);
    if (lines.length > 0) return lines;
  }

  // lint
  if (toolName === 'lint' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const linter = stringOf(o['linter']);
    const files = numOf(o['files_checked']);
    const errors = numOf(o['errors']) ?? 0;
    const warnings = numOf(o['warnings']) ?? 0;
    const fix = o['fix_applied'] === true;
    const head: string[] = [];
    if (linter && linter !== 'none') head.push(linter);
    head.push(`${errors} error${errors === 1 ? '' : 's'}`);
    head.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
    if (files !== undefined) head.push(`${files} file${files === 1 ? '' : 's'}`);
    if (fix) head.push('fixed');
    return [head.join(' · ')];
  }

  // format
  if (toolName === 'format' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const fixer = stringOf(o['fixer']);
    const checked = numOf(o['files_checked']);
    const changed = numOf(o['files_changed']);
    const head: string[] = [];
    if (fixer && fixer !== 'none') head.push(fixer);
    if (changed !== undefined && checked !== undefined) {
      head.push(`${changed}/${checked} changed`);
    } else if (changed !== undefined) {
      head.push(`${changed} changed`);
    }
    return head.length > 0 ? [head.join(' · ')] : [];
  }

  // typecheck
  if (toolName === 'typecheck' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
    const errors = numOf(o['errors']);
    const head: string[] = [];
    if (errors !== undefined) head.push(`${errors} error${errors === 1 ? '' : 's'}`);
    if (exit !== undefined) head.push(`exit ${exit}`);
    const stdout = stringOf(o['output']) ?? stringOf(o['stdout']) ?? '';
    const lines: string[] = [];
    if (head.length > 0) lines.push(head.join(' · '));
    const preview = firstNonEmpty(stdout);
    if (preview && (!errors || errors > 0)) lines.push(`"${truncMid(preview, 70)}"`);
    if (lines.length > 0) return lines;
  }

  // test
  if (toolName === 'test' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const runner = stringOf(o['runner']);
    const total = numOf(o['tests_run']) ?? 0;
    const passed = numOf(o['passed']) ?? 0;
    const failed = numOf(o['failed']) ?? 0;
    const duration = numOf(o['duration_ms']);
    const head: string[] = [];
    if (runner && runner !== 'none') head.push(runner);
    head.push(`${passed}/${total} passed`);
    if (failed > 0) head.push(`${failed} failed`);
    if (duration !== undefined) head.push(fmtDuration(duration));
    return [head.join(' · ')];
  }

  // audit
  if (toolName === 'audit' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const total = numOf(o['total']) ?? 0;
    const summary = stringOf(o['summary']);
    if (total === 0) return ['no vulnerabilities'];
    const head = `${total} vulnerabilit${total === 1 ? 'y' : 'ies'}`;
    return summary && summary.toLowerCase() !== head.toLowerCase()
      ? [head, truncMid(summary, OUT_BUDGET)]
      : [head];
  }

  // outdated
  if (toolName === 'outdated' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const total = numOf(o['total']) ?? 0;
    const pkgs = Array.isArray(o['packages']) ? (o['packages'] as unknown[]) : undefined;
    if (total === 0) return ['all up to date'];
    const lines: string[] = [`${total} outdated`];
    if (pkgs && pkgs.length > 0) {
      const first = pkgs[0];
      if (first && typeof first === 'object') {
        const p = first as Record<string, unknown>;
        const name = stringOf(p['name']) ?? stringOf(p['package']);
        const cur = stringOf(p['current']);
        const wanted = stringOf(p['wanted']) ?? stringOf(p['latest']);
        if (name && cur && wanted) lines.push(`${name}: ${cur} → ${wanted}`);
        else if (name) lines.push(name);
      }
    }
    return lines;
  }

  // tree
  if (toolName === 'tree' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const files = numOf(o['total_files']);
    const dirs = numOf(o['total_dirs']);
    const truncated = o['truncated'] === true;
    const parts: string[] = [];
    if (files !== undefined) parts.push(`${files} file${files === 1 ? '' : 's'}`);
    if (dirs !== undefined) parts.push(`${dirs} dir${dirs === 1 ? '' : 's'}`);
    if (truncated) parts.push('truncated');
    return parts.length > 0 ? [parts.join(' · ')] : [];
  }

  // json
  if (toolName === 'json' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const err = stringOf(o['error']);
    if (err) return [truncMid(err, OUT_BUDGET)];
    const type = stringOf(o['type']);
    const keys = Array.isArray(o['keys']) ? (o['keys'] as unknown[]) : undefined;
    const parts: string[] = [];
    if (type) parts.push(type);
    if (keys) parts.push(`${keys.length} key${keys.length === 1 ? '' : 's'}`);
    return parts.length > 0 ? [parts.join(' · ')] : [];
  }

  // install
  if (toolName === 'install' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
    const added = numOf(o['added']);
    const removed = numOf(o['removed']);
    const head: string[] = [];
    if (exit !== undefined) head.push(`exit ${exit}`);
    if (added !== undefined) head.push(`+${added}`);
    if (removed !== undefined) head.push(`-${removed}`);
    const stdout = stringOf(o['stdout']) ?? stringOf(o['output']) ?? '';
    const lines: string[] = [];
    if (head.length > 0) lines.push(head.join(' · '));
    const preview = firstNonEmpty(stdout);
    if (preview) lines.push(`"${truncMid(preview, 70)}"`);
    if (lines.length > 0) return lines;
  }

  // scaffold
  if (toolName === 'scaffold' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const created = Array.isArray(o['created']) ? (o['created'] as unknown[]) : undefined;
    const skipped = Array.isArray(o['skipped']) ? (o['skipped'] as unknown[]) : undefined;
    const parts: string[] = [];
    if (created !== undefined) parts.push(`${created.length} created`);
    if (skipped !== undefined && skipped.length > 0) parts.push(`${skipped.length} skipped`);
    if (parts.length > 0) return [parts.join(' · ')];
  }

  // remember / forget / memory
  if (toolName === 'remember' || toolName === 'forget' || toolName === 'memory') {
    return ok ? [toolName === 'forget' ? 'removed' : 'saved'] : [text.split('\n')[0] ?? ''];
  }

  // mode
  if (toolName === 'mode' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const mode = stringOf(o['mode']) ?? stringOf(o['active']) ?? stringOf(o['name']);
    if (mode) return [`mode: ${mode}`];
  }

  // search
  if (toolName === 'search' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const matches = Array.isArray(o['matches'])
      ? (o['matches'] as unknown[])
      : Array.isArray(o['results'])
        ? (o['results'] as unknown[])
        : undefined;
    const count = numOf(o['count']) ?? matches?.length;
    if (count !== undefined) {
      if (count === 0) return ['no results'];
      const lines: string[] = [`${count} result${count === 1 ? '' : 's'}`];
      const firstHit = matches && matches.length > 0 ? formatMatchHit(matches[0]) : undefined;
      if (firstHit) lines.push(firstHit);
      return lines;
    }
  }

  // logs
  if (toolName === 'logs') {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return [];
    const head = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
    const lastLine = lines[lines.length - 1];
    return lastLine ? [head, `"${truncMid(lastLine.trim(), 70)}"`] : [head];
  }

  // Generic fallback
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const summary = summarizeJsonObject(json as Record<string, unknown>);
    if (summary) return [summary];
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return [truncMid(collapsed, GENERIC_BUDGET)];
}
// ============================================
// Semantic tool output preview
// ============================================

const VISUAL_MAX_LINES = 7;

/**
 * Build richer terminal-native rows for common tool outputs. This handles both
 * raw JSON-shaped results used by unit tests and the compact serializer text
 * emitted in real sessions.
 */
export function formatToolVisualOutput(
  toolName: string,
  output: string | undefined,
  ok: boolean,
  input?: unknown | undefined,
): ToolVisualLine[] | undefined {
  if (!output) return undefined;
  const text = output.trim();
  if (!text) return undefined;

  if (toolName === 'read' || toolName === 'view_file') return visualRead(text);
  if (toolName === 'grep' || toolName === 'search' || toolName === 'grep_search')
    return visualSearch(toolName, text);
  if (
    toolName === 'glob' ||
    toolName === 'find' ||
    toolName === 'find_by_name' ||
    toolName === 'find_files' ||
    toolName === 'list_dir' ||
    toolName === 'dir_list' ||
    toolName === 'list_directory'
  ) {
    return visualPathList(toolName, text);
  }
  if (toolName === 'tree') return visualTree(text);
  // Edit-style tools render two layers: a compact meta line via
  // `visualEdit` (path + replacement count) at the top, then the actual
  // diff body via the dedicated `<DiffBlock>` that `entry.tsx` already
  // renders below. Without the meta line the user only sees the diff
  // body and may miss which file got touched; with it they get the
  // summary even in `simple` mode where the diff body is hidden.
  if (
    toolName === 'edit' ||
    toolName === 'replace_file_content' ||
    toolName === 'write' ||
    toolName === 'write_to_file' ||
    toolName === 'diff' ||
    toolName === 'patch' ||
    toolName === 'replace'
  ) {
    return visualEdit(toolName, text, ok);
  }
  if (
    toolName === 'bash' ||
    toolName === 'shell' ||
    toolName === 'run_command' ||
    toolName === 'git' ||
    toolName === 'exec' ||
    toolName === 'install'
  ) {
    return visualCommand(toolName, text, ok);
  }
  if (
    toolName === 'test' ||
    toolName === 'lint' ||
    toolName === 'typecheck' ||
    toolName === 'format'
  ) {
    return visualVerifier(toolName, text, ok);
  }
  if (
    toolName === 'fetch' ||
    toolName === 'webfetch' ||
    toolName === 'web_fetch' ||
    toolName === 'read_url_content'
  ) {
    return visualFetch(text);
  }
  if (toolName === 'json') return visualJson(text);
  if (toolName === 'outdated') return visualOutdated(text);
  if (toolName === 'audit') return visualAudit(text);
  if (toolName === 'scaffold') return visualScaffold(text);
  if (toolName === 'todo') return visualTodo(text, input);
  if (toolName === 'task' || toolName === 'plan') return visualWorkBoard(toolName, text, ok);
  if (
    toolName === 'remember' ||
    toolName === 'forget' ||
    toolName === 'search_memory' ||
    toolName === 'find_related_memories'
  ) {
    return visualMemory(toolName, text, ok);
  }
  if (toolName === 'logs') return visualLogs(text);
  if (toolName === 'document') return visualDocument(text);
  if (toolName === 'tool_help' || toolName === 'tool_search')
    return visualToolCatalog(toolName, text);
  if (toolName === 'tool_use' || toolName === 'batch_tool_use')
    return visualMetaExecution(toolName, text, ok);
  if (
    toolName === 'codebase-index' ||
    toolName === 'codebase-search' ||
    toolName === 'codebase-stats' ||
    toolName === 'codebase-incoming-calls' ||
    toolName === 'codebase-outgoing-calls'
  ) {
    return visualCodebase(toolName, text, ok);
  }
  if (toolName.startsWith('lsp_') || toolName === 'codebase-lsp-search') {
    return visualLsp(toolName, text, ok);
  }
  if (toolName === 'set_working_dir') return visualWorkingDir(text, ok);
  if (toolName === 'mode') return visualMode(text, ok);
  return undefined;
}

/**
 * Render the meta line for edit-style tools (`edit`, `write`, `diff`,
 * `patch`, `replace`). The actual diff body is rendered separately by
 * `<DiffBlock>` in `entry.tsx`; this function only produces the compact
 * summary that lives above it — `path · N replacement(s)` for `edit`,
 * `path · N bytes` for `write`, `diff N file(s)` for `diff`/`patch`,
 * `replace · N file(s)` for `replace`. Failing to render means the
 * user only sees the raw diff body (or nothing in `simple` mode),
 * which makes the tool entry look empty.
 */
function visualEdit(toolName: string, text: string, ok: boolean): ToolVisualLine[] | undefined {
  const rows: ToolVisualLine[] = [];
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const path = typeof obj['path'] === 'string' ? (obj['path'] as string) : undefined;
    const replacements =
      typeof obj['replacements'] === 'number' ? (obj['replacements'] as number) : undefined;
    const bytes = typeof obj['bytes'] === 'number' ? (obj['bytes'] as number) : undefined;
    const created = obj['created'] === true;
    const files = Array.isArray(obj['files']) ? (obj['files'] as unknown[]) : undefined;
    const results = Array.isArray(obj['results']) ? (obj['results'] as unknown[]) : undefined;

    if (toolName === 'edit' && path !== undefined) {
      const repText =
        replacements !== undefined
          ? `${replacements} replacement${replacements === 1 ? '' : 's'}`
          : undefined;
      rows.push({ kind: 'ok', text: '', marker: 'edit ', path });
      if (repText) rows.push({ kind: 'meta', text: repText });
    } else if (toolName === 'write' && path !== undefined) {
      const sizeText = bytes !== undefined ? `${bytes} bytes` : created ? 'new file' : 'updated';
      rows.push({ kind: 'ok', text: '', marker: 'write ', path });
      rows.push({ kind: 'meta', text: sizeText });
    } else if ((toolName === 'diff' || toolName === 'patch') && files && files.length > 0) {
      rows.push({
        kind: 'ok',
        marker: `${toolName} `,
        text: `${files.length} file${files.length === 1 ? '' : 's'}`,
      });
    } else if (toolName === 'replace' && results && results.length > 0) {
      const pathSet = new Set<string>();
      for (const r of results) {
        if (r && typeof r === 'object') {
          const p = (r as Record<string, unknown>)['path'];
          if (typeof p === 'string') pathSet.add(p);
        }
      }
      const pathList = Array.from(pathSet);
      const fileCount = pathList.length || results.length;
      rows.push({
        kind: 'ok',
        marker: 'replace ',
        text: `${results.length} replacement${results.length === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}`,
      });
    } else if (path !== undefined) {
      // Fallback: we have JSON but no recognised shape — still surface
      // the path so the user knows which file got touched.
      rows.push({ kind: 'ok', text: '', marker: `${toolName} `, path });
    } else {
      return undefined;
    }
  } else {
    // Non-JSON output: surface the first non-empty line so the user
    // at least sees *something* (matches the read-tool fallback in
    // visualRead).
    const first = firstNonEmpty(text);
    if (!first) return undefined;
    rows.push({ kind: 'meta', text: first.length > 80 ? `${first.slice(0, 77)}…` : first });
  }
  // Append an error flag for non-ok runs so the visual summary reflects
  // failure when the meta comes from a successful call site.
  if (!ok) rows.push({ kind: 'error', marker: '! ', text: 'edit failed' });
  return rows;
}

function visualRead(text: string): ToolVisualLine[] | undefined {
  const header = parseHeaderLine(text);
  const lines = bodyLines(text);
  const numbered = lines
    .map((line) => line.match(/^\s*(\d+)→(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match?.[1]));
  if (numbered.length === 0) {
    const first = firstNonEmpty(lines.join('\n'));
    return first ? [{ kind: 'meta', text: first }] : undefined;
  }

  const first = Number.parseInt(numbered[0]?.[1] ?? '', 10);
  const last = Number.parseInt(numbered[numbered.length - 1]?.[1] ?? '', 10);
  const total = numberFromParsedField(header.fields, 'total_lines');
  const parts: string[] = [];
  if (Number.isFinite(first) && Number.isFinite(last)) {
    parts.push(first === last ? `L${first}` : `L${first}–${last}`);
  }
  const contiguous =
    Number.isFinite(first) && Number.isFinite(last) ? numbered.length === last - first + 1 : true;
  parts.push(
    `${numbered.length} line${numbered.length === 1 ? '' : 's'}${contiguous ? '' : ' (gaps)'}`,
  );
  if (total !== undefined && total !== numbered.length) parts.push(`${total} total`);
  if (header.fields['truncated'] === 'true') parts.push('truncated');
  if (header.fields['cached'] === 'true') parts.push('cached');
  return [{ kind: 'meta', text: parts.join(' · ') }];
}

function visualSearch(toolName: string, text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const matches = Array.isArray(obj['matches'])
      ? (obj['matches'] as unknown[])
      : Array.isArray(obj['results'])
        ? (obj['results'] as unknown[])
        : [];
    return visualSearchMatches(matches, numOf(obj['count']) ?? matches.length);
  }

  const lines = bodyLines(text);
  if (lines.length === 0 || lines[0] === '(no matches)') return undefined;
  const rows: ToolVisualLine[] = [];
  let currentPath: string | undefined;
  let consumed = 0;
  for (const line of lines) {
    if (consumed >= VISUAL_MAX_LINES) break;
    const fileHeader = line.match(/^(.+?) \((\d+) match\(es\), showing \d+\)$/);
    if (fileHeader?.[1]) {
      currentPath = fileHeader[1];
      rows.push({ kind: 'path', path: currentPath, text: `${fileHeader[2] ?? '?'} match(es)` });
      consumed++;
      continue;
    }
    const direct = line.match(/^((?:[A-Za-z]:)?[^:]+):(\d+)[:\-](.*)$/);
    const grouped = line.match(/^(\d+)[:\-](.*)$/);
    if (direct?.[1] && direct[2]) {
      rows.push({ kind: 'match', path: direct[1], lineNo: direct[2], text: direct[3] ?? '' });
      consumed++;
    } else if (grouped?.[1]) {
      rows.push({ kind: 'match', path: currentPath, lineNo: grouped[1], text: grouped[2] ?? '' });
      consumed++;
    } else if (line.trim() && !line.startsWith(`${toolName}:`)) {
      rows.push({ kind: 'meta', text: line.trim() });
      consumed++;
    }
  }
  if (lines.length > consumed)
    rows.push({ kind: 'meta', text: `${lines.length - consumed} more result line(s)` });
  return rows.length > 0 ? rows : undefined;
}

function visualSearchMatches(matches: unknown[], count: number): ToolVisualLine[] | undefined {
  if (count === 0) return [{ kind: 'ok', marker: 'ok ', text: 'no matches' }];
  const rows: ToolVisualLine[] = [];
  for (const match of matches.slice(0, VISUAL_MAX_LINES)) {
    const hit = parseMatchHit(match);
    if (hit) rows.push({ kind: 'match', path: hit.path, lineNo: hit.line, text: hit.text });
  }
  if (rows.length === 0)
    return count > 0
      ? [{ kind: 'meta', text: `${count} result${count === 1 ? '' : 's'}` }]
      : undefined;
  if (count > rows.length)
    rows.push({ kind: 'meta', text: `${count - rows.length} more result(s)` });
  return rows;
}

function parseMatchHit(
  hit: unknown,
): { path?: string | undefined; line?: string | undefined; text: string } | undefined {
  if (typeof hit === 'string') {
    const m = hit.match(/^((?:[A-Za-z]:)?[^:]+):(\d+)[:\-](.*)$/);
    return m?.[1] && m[2] ? { path: m[1], line: m[2], text: m[3] ?? '' } : { text: hit };
  }
  if (hit && typeof hit === 'object') {
    const o = hit as Record<string, unknown>;
    const path =
      stringOf(o['file']) ??
      stringOf(o['path']) ??
      stringOf(o['url']) ??
      stringOf(o['filename']) ??
      stringOf(o['Filename']);
    const lineNum =
      numOf(o['line']) ??
      numOf(o['lineNumber']) ??
      numOf(o['line_number']) ??
      numOf(o['LineNumber']);
    const line = lineNum === undefined ? undefined : String(lineNum);
    const title = stringOf(o['title']);
    const snippet =
      stringOf(o['snippet']) ??
      stringOf(o['lineContent']) ??
      stringOf(o['LineContent']) ??
      stringOf(o['line_content']);
    const text =
      stringOf(o['text']) ??
      stringOf(o['match']) ??
      stringOf(o['preview']) ??
      snippet ??
      title ??
      [title, snippet].filter(Boolean).join(' — ');
    return { path, line, text };
  }
  return undefined;
}

function visualPathList(toolName: string, text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  const rawList =
    json && typeof json === 'object'
      ? Array.isArray((json as Record<string, unknown>)['files'])
        ? (json as Record<string, unknown>)['files']
        : Array.isArray((json as Record<string, unknown>)['paths'])
          ? (json as Record<string, unknown>)['paths']
          : Array.isArray((json as Record<string, unknown>)['matches'])
            ? (json as Record<string, unknown>)['matches']
            : Array.isArray((json as Record<string, unknown>)['entries'])
              ? (json as Record<string, unknown>)['entries']
              : Array.isArray(json)
                ? json
                : undefined
      : undefined;

  const files = rawList
    ? (rawList as unknown[])
        .map((v) => {
          if (typeof v === 'string') return v;
          if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            return (
              stringOf(o['path']) ??
              stringOf(o['relativePath']) ??
              stringOf(o['name']) ??
              stringOf(o['file'])
            );
          }
          return undefined;
        })
        .filter((v): v is string => typeof v === 'string')
    : bodyLines(text).filter((line) => line.trim() && !line.startsWith(`${toolName}:`));

  if (files.length === 0) return undefined;
  const rows = files.slice(0, VISUAL_MAX_LINES).map(
    (file): ToolVisualLine => ({
      kind: 'path',
      path: file,
      text: '',
    }),
  );
  if (files.length > rows.length)
    rows.push({ kind: 'meta', text: `${files.length - rows.length} more path(s)` });
  return rows;
}

function visualTree(text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const files = numOf(obj['total_files']) ?? numOf(obj['files']);
    const dirs = numOf(obj['total_dirs']) ?? numOf(obj['dirs']);
    if (files !== undefined || dirs !== undefined) {
      const parts = [
        files !== undefined ? `${files} file${files === 1 ? '' : 's'}` : undefined,
        dirs !== undefined ? `${dirs} dir${dirs === 1 ? '' : 's'}` : undefined,
        obj['truncated'] === true ? 'truncated' : undefined,
      ].filter(Boolean);
      return [{ kind: 'meta', text: parts.join(' · ') }];
    }
  }
  const lines = bodyLines(text).filter((line) => line.trim());
  if (lines.length === 0) return undefined;
  const rows = lines.slice(0, VISUAL_MAX_LINES).map(
    (line): ToolVisualLine => ({
      kind: line.includes('──') || line.includes('|--') ? 'path' : 'meta',
      text: line,
    }),
  );
  if (lines.length > rows.length)
    rows.push({ kind: 'meta', text: `${lines.length - rows.length} more tree line(s)` });
  return rows;
}

function visualVerifier(toolName: string, text: string, ok: boolean): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const errors = numOf(obj['errors']) ?? numOf(obj['failed']) ?? 0;
    const warnings = numOf(obj['warnings']) ?? 0;
    const changed = numOf(obj['files_changed']) ?? 0;
    const statusKind: ToolVisualLineKind =
      !ok || errors > 0 ? 'error' : changed > 0 ? 'warn' : 'ok';
    const parts = [
      toolName,
      errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : undefined,
      warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : undefined,
      changed > 0 ? `${changed} changed` : undefined,
      toolName === 'test'
        ? `${numOf(obj['passed']) ?? 0}/${numOf(obj['tests_run']) ?? 0} passed`
        : undefined,
    ].filter(Boolean);
    return [
      {
        kind: statusKind,
        marker: statusKind === 'ok' ? 'ok ' : statusKind === 'warn' ? '! ' : 'x ',
        text: parts.join(' · ') || toolName,
      },
    ];
  }

  const header = parseHeaderLine(text);
  const sections = parseNamedSections(text);
  const report = sections.get('report') ?? '';
  const errorContext = sections.get('error_context');
  const fields = { ...header.fields, ...parseKeyValueLines(report) };
  const status = fields['status'];
  const errorCount =
    numberFromParsedField(fields, 'errors') ?? numberFromParsedField(fields, 'failed') ?? 0;
  const warningCount = numberFromParsedField(fields, 'warnings') ?? 0;
  const changed = numberFromParsedField(fields, 'files_changed') ?? 0;
  const statusKind: ToolVisualLineKind =
    !ok || errorContext || errorCount > 0
      ? 'error'
      : status === 'changed' || changed > 0
        ? 'warn'
        : 'ok';
  const rows: ToolVisualLine[] = [
    {
      kind: statusKind,
      marker: statusKind === 'ok' ? 'ok ' : statusKind === 'warn' ? '! ' : 'x ',
      text: [
        toolName,
        status ? `status=${status}` : undefined,
        errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : undefined,
        warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : undefined,
        changed > 0 ? `${changed} changed` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];
  appendOutputPreview(rows, errorContext, 'stderr');
  return rows.slice(0, VISUAL_MAX_LINES);
}
