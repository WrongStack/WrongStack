import { Box, Text, useAnimation } from '../../ink.js';
import React from 'react';
import { getToolVisual } from '../../tool-glyph.js';

// ============================================
// Utility functions used across history components
// ============================================

export function shortenPath(p: string, max: number): string {
  if (p.length <= max) return p;
  return `…${p.slice(p.length - (max - 1))}`;
}

const MAX_PREVIEW = 120;

export function previewArgs(input: unknown): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return collapse(s, MAX_PREVIEW);
}

export function previewOutput(output: string): string {
  return collapse(output, MAX_PREVIEW);
}

function collapse(s: string, max: number): string {
  const oneLine = s.replace(/\r?\n/g, '↵').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncMid(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function tryParseJson(s: string): unknown {
  const t = s.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function scanNumberedRange(text: string): {
  first?: number | undefined;
  last?: number | undefined;
  count: number;
} {
  let first: number | undefined;
  let last: number | undefined;
  let count = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)→/);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) {
        if (first === undefined) first = n;
        last = n;
        count++;
      }
    }
  }
  return { first, last, count };
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

export function firstNonEmpty(text: string): string | undefined {
  if (!text) return undefined;
  const line = text.split('\n').find((l) => l.trim());
  return line ? line.replace(/\s+/g, ' ').trim() : undefined;
}

export function formatMatchHit(hit: unknown): string | undefined {
  if (typeof hit === 'string') return truncMid(hit, 70);
  if (hit && typeof hit === 'object') {
    const o = hit as Record<string, unknown>;
    const file = stringOf(o['file']) ?? stringOf(o['path']);
    const line = numOf(o['line']) ?? numOf(o['lineNumber']);
    const snippet = stringOf(o['text']) ?? stringOf(o['match']) ?? stringOf(o['preview']);
    if (file) {
      const head = line !== undefined ? `${shortenPath(file, 40)}:${line}` : shortenPath(file, 50);
      return snippet ? `${head}  ${truncMid(snippet.replace(/\s+/g, ' '), 40)}` : head;
    }
    if (snippet) return truncMid(snippet, 70);
  }
  return undefined;
}

// ============================================
// Tool argument formatting
// ============================================

const ARG_BUDGET = 60;

function stringArrayOf(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function fileScopeSummary(files: unknown, fallback?: string | undefined): string {
  const list = stringArrayOf(files);
  if (list && list.length > 0) {
    const first = list[0] ?? '';
    const more = list.length > 1 ? ` (+${list.length - 1})` : '';
    return first ? `${shortenPath(first, 42)}${more}` : `${list.length} files`;
  }
  const scalar = typeof files === 'string' ? files : fallback;
  return scalar ? shortenPath(scalar, 44) : '';
}

/**
 * Render the most useful single-line description of a tool call's arguments.
 */
export function formatToolArgs(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
    case 'patch':
    case 'list_dir':
    case 'ls':
    case 'tree': {
      const p = stringOf(obj['path']) ?? stringOf(obj['file']);
      return p ? shortenPath(p, ARG_BUDGET) : '';
    }
    case 'document': {
      const target = stringOf(obj['target']) ?? 'all';
      const scope = fileScopeSummary(obj['files'], stringOf(obj['path']));
      const style = stringOf(obj['style']);
      return [target, scope, style].filter(Boolean).join(' · ');
    }
    case 'grep':
    case 'search':
    case 'replace': {
      const pat = stringOf(obj['pattern']) ?? stringOf(obj['query']);
      const scope = stringOf(obj['path']) ?? stringOf(obj['glob']);
      const head = pat ? `"${truncMid(pat, 36)}"` : '';
      const tail = scope ? ` in ${shortenPath(scope, 28)}` : '';
      return `${head}${tail}` || (stringOf(obj['command']) ?? '');
    }
    case 'glob': {
      const pat = stringOf(obj['pattern']) ?? stringOf(obj['glob']);
      return pat ? `"${truncMid(pat, ARG_BUDGET - 2)}"` : '';
    }
    case 'bash':
    case 'shell':
    case 'install':
    case 'git': {
      const cmd = stringOf(obj['command']) ?? stringOf(obj['args']);
      return cmd ? truncMid(cmd, ARG_BUDGET) : '';
    }
    case 'exec': {
      const command = stringOf(obj['command']);
      const args = stringArrayOf(obj['args']) ?? [];
      const cwd = stringOf(obj['cwd']);
      const cmd = [command, ...args].filter(Boolean).join(' ');
      const head = cmd ? truncMid(cmd, cwd ? 44 : ARG_BUDGET) : '';
      return cwd ? `${head} in ${shortenPath(cwd, 14)}` : head;
    }
    case 'diff': {
      const files = Array.isArray(obj['files']) ? (obj['files'] as unknown[]) : undefined;
      if (files && files.length > 0) {
        const head = stringOf(files[0]) ?? '';
        const rest = files.length > 1 ? ` (+${files.length - 1})` : '';
        return head ? `${shortenPath(head, 50)}${rest}` : '';
      }
      const mode = stringOf(obj['mode']);
      return mode ? `mode: ${mode}` : '';
    }
    case 'fetch':
    case 'webfetch':
    case 'web_fetch': {
      const u = stringOf(obj['url']);
      return u ? truncMid(u, ARG_BUDGET) : '';
    }
    case 'todo': {
      const list = obj['todos'];
      if (Array.isArray(list)) return `${list.length} item${list.length === 1 ? '' : 's'}`;
      return '';
    }
    case 'plan': {
      const action = stringOf(obj['action']) ?? 'show';
      const target =
        stringOf(obj['target']) ?? stringOf(obj['title']) ?? stringOf(obj['template']) ?? '';
      const scope = stringOf(obj['scope']);
      return [action, target ? truncMid(target, 34) : '', scope].filter(Boolean).join(' · ');
    }
    case 'task': {
      const action = stringOf(obj['action']) ?? 'show';
      const task =
        obj['task'] && typeof obj['task'] === 'object'
          ? (obj['task'] as Record<string, unknown>)
          : undefined;
      const target =
        stringOf(obj['target']) ??
        stringOf(obj['id']) ??
        stringOf(task?.['title']) ??
        (Array.isArray(obj['tasks']) ? `${obj['tasks'].length} tasks` : '');
      const status = stringOf(obj['status']);
      return [action, target ? truncMid(target, 32) : '', status].filter(Boolean).join(' · ');
    }
    case 'lint':
    case 'format':
    case 'typecheck':
    case 'test':
    case 'audit':
    case 'outdated': {
      const files = obj['files'];
      if (Array.isArray(files) && files.length > 0) {
        const first = stringOf(files[0]);
        const more = files.length > 1 ? ` (+${files.length - 1})` : '';
        return first ? `${shortenPath(first, 50)}${more}` : `${files.length} files`;
      }
      const filter = stringOf(obj['filter']) ?? stringOf(obj['pattern']);
      return filter ? `"${truncMid(filter, ARG_BUDGET - 2)}"` : '';
    }
    case 'json': {
      const file = stringOf(obj['file']);
      const q = stringOf(obj['query']);
      if (file) return q ? `${shortenPath(file, 40)}  ${q}` : shortenPath(file, ARG_BUDGET);
      return q ? truncMid(q, ARG_BUDGET) : '';
    }
    case 'scaffold': {
      const tmpl = stringOf(obj['template']) ?? stringOf(obj['type']);
      const name = stringOf(obj['name']);
      if (tmpl && name) return `${tmpl} → ${truncMid(name, ARG_BUDGET - tmpl.length - 4)}`;
      return name ?? tmpl ?? '';
    }
    case 'remember': {
      const scope = stringOf(obj['scope']);
      const type = stringOf(obj['type']);
      const text = stringOf(obj['text']);
      return [scope, type, text ? truncMid(text, 34) : ''].filter(Boolean).join(' · ');
    }
    case 'forget': {
      const query = stringOf(obj['query']);
      const scope = stringOf(obj['scope']);
      return [query ? `"${truncMid(query, 36)}"` : '', scope].filter(Boolean).join(' · ');
    }
    case 'search_memory':
    case 'find_related_memories': {
      const query = stringOf(obj['query']) ?? stringOf(obj['text']);
      const scope = stringOf(obj['scope']);
      return [query ? `"${truncMid(query, 36)}"` : '', scope].filter(Boolean).join(' · ');
    }
    case 'memory': {
      const key = stringOf(obj['key']) ?? stringOf(obj['name']);
      return key ? truncMid(key, ARG_BUDGET) : '';
    }
    case 'mode': {
      const action = stringOf(obj['action']);
      const m = stringOf(obj['mode']) ?? stringOf(obj['name']);
      return [action, m].filter(Boolean).join(' · ');
    }
    case 'logs': {
      const target = stringOf(obj['target']) ?? stringOf(obj['service']) ?? stringOf(obj['path']);
      const filter = stringOf(obj['filter']);
      const since = stringOf(obj['since']);
      const lines = typeof obj['lines'] === 'number' ? `${obj['lines']} lines` : '';
      return [
        target ? shortenPath(target, 34) : '',
        filter ? `/${truncMid(filter, 16)}/` : '',
        since,
        lines,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'tool_help': {
      const tool = stringOf(obj['tool']) ?? 'all';
      const format = stringOf(obj['format']);
      return [tool, format].filter(Boolean).join(' · ');
    }
    case 'tool_search': {
      const query = stringOf(obj['query']);
      const tags = stringArrayOf(obj['tags']);
      const filters = [
        query ? `"${truncMid(query, 28)}"` : '',
        tags && tags.length > 0 ? tags.join(',') : '',
        stringOf(obj['permission']),
        typeof obj['mutating'] === 'boolean' ? (obj['mutating'] ? 'mutating' : 'read-only') : '',
      ].filter(Boolean);
      return filters.join(' · ');
    }
    case 'tool_use': {
      const tool = stringOf(obj['tool']);
      return tool ? `call ${tool}` : '';
    }
    case 'batch_tool_use': {
      const calls = Array.isArray(obj['calls']) ? obj['calls'] : [];
      const mode = obj['parallel'] === false ? 'sequential' : 'parallel';
      return `${calls.length} call${calls.length === 1 ? '' : 's'} · ${mode}`;
    }
    case 'codebase-index': {
      const langs = stringArrayOf(obj['langs']);
      const force = obj['force'] === true ? 'force' : '';
      return [force, langs && langs.length > 0 ? langs.join(',') : 'incremental']
        .filter(Boolean)
        .join(' · ');
    }
    case 'codebase-search': {
      const query = stringOf(obj['query']);
      const filters = [
        stringOf(obj['kind']),
        stringOf(obj['lang']),
        stringOf(obj['file']) ? `in ${shortenPath(String(obj['file']), 24)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return [query ? `"${truncMid(query, 30)}"` : '', filters].filter(Boolean).join(' · ');
    }
    case 'codebase-stats':
      return 'index health';
    case 'lsp_diagnostics': {
      const path = stringOf(obj['path']);
      const severity = stringArrayOf(obj['severity']) ?? stringArrayOf(obj['severities']);
      return [path ? shortenPath(path, 40) : 'workspace', severity?.join('+')]
        .filter(Boolean)
        .join(' · ');
    }
    case 'lsp_definition':
    case 'lsp_completion':
    case 'lsp_rename': {
      const path = stringOf(obj['path']) ?? stringOf(obj['file']);
      const line = numOf(obj['line']);
      const character = numOf(obj['character']);
      const position = line !== undefined ? `L${line}:${character ?? 1}` : '';
      const rename = toolName === 'lsp_rename' ? stringOf(obj['new_name']) : undefined;
      return [path ? shortenPath(path, 38) : '', position, rename ? `→ ${rename}` : '']
        .filter(Boolean)
        .join(' · ');
    }
    case 'set_working_dir': {
      const p = stringOf(obj['path']);
      return p ? shortenPath(p, ARG_BUDGET) : 'current';
    }
  }

  for (const key of ['path', 'file', 'url', 'name', 'query', 'pattern', 'command']) {
    const v = stringOf(obj[key]);
    if (v) return truncMid(v, ARG_BUDGET);
  }
  try {
    return truncMid(JSON.stringify(obj), ARG_BUDGET);
  } catch {
    return '';
  }
}

// ============================================
// Tool output formatting
// ============================================

const OUT_BUDGET = 80;
const GENERIC_BUDGET = 240;

function summarizeJsonObject(obj: Record<string, unknown>): string | null {
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  const priority = [
    'ok',
    'status',
    'timedOut',
    'stopReason',
    'reason',
    'error',
    'message',
    'result',
    'summary',
    'iterations',
    'toolCalls',
    'durationMs',
    'subagentId',
    'taskId',
  ];
  const ordered = [
    ...priority.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !priority.includes(k)),
  ];
  const parts: string[] = [];
  let used = 0;
  for (const key of ordered) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const rendered =
      typeof v === 'string'
        ? `${key}="${truncMid(v.replace(/\s+/g, ' '), 80)}"`
        : typeof v === 'number' || typeof v === 'boolean'
          ? `${key}=${v}`
          : Array.isArray(v)
            ? `${key}=[${v.length}]`
            : `${key}={…}`;
    if (used + rendered.length > GENERIC_BUDGET) {
      parts.push('…');
      break;
    }
    parts.push(rendered);
    used += rendered.length + 3;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

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

export type ToolVisualLineKind =
  | 'ok'
  | 'warn'
  | 'error'
  | 'meta'
  | 'path'
  | 'match'
  | 'code'
  | 'stdout'
  | 'stderr';

export interface ToolVisualLine {
  kind: ToolVisualLineKind;
  text: string;
  marker?: string | undefined;
  lineNo?: string | undefined;
  path?: string | undefined;
}

const VISUAL_MAX_LINES = 7;
const VISUAL_TEXT_BUDGET = 92;

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

  if (toolName === 'read') return visualRead(text);
  if (toolName === 'grep' || toolName === 'search') return visualSearch(toolName, text);
  if (toolName === 'glob') return visualPathList(toolName, text);
  if (toolName === 'tree') return visualTree(text);
  // Edit-style tools render two layers: a compact meta line via
  // `visualEdit` (path + replacement count) at the top, then the actual
  // diff body via the dedicated `<DiffBlock>` that `entry.tsx` already
  // renders below. Without the meta line the user only sees the diff
  // body and may miss which file got touched; with it they get the
  // summary even in `simple` mode where the diff body is hidden.
  if (
    toolName === 'edit' ||
    toolName === 'write' ||
    toolName === 'diff' ||
    toolName === 'patch' ||
    toolName === 'replace'
  ) {
    return visualEdit(toolName, text, ok);
  }
  if (
    toolName === 'bash' ||
    toolName === 'shell' ||
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
  if (toolName === 'fetch' || toolName === 'webfetch' || toolName === 'web_fetch') {
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
    toolName === 'codebase-stats'
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

/** Turn the compact text emitted by plug-lsp into navigable, severity-aware rows. */
function visualLsp(toolName: string, text: string, ok: boolean): ToolVisualLine[] {
  const json = tryParseJson(text);
  if (toolName === 'lsp_completion' && json && typeof json === 'object' && !Array.isArray(json)) {
    const items = (json as { items?: unknown }).items;
    if (Array.isArray(items)) {
      const rows = items.slice(0, VISUAL_MAX_LINES).map((item): ToolVisualLine => {
        const value = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        const label = stringOf(value['label']) ?? '(unnamed)';
        const kind = stringOf(value['kind']);
        const detail = stringOf(value['detail']);
        return {
          kind: 'code',
          marker: glyphForLspKind(kind),
          text: [label, kind ? `[${kind}]` : '', detail].filter(Boolean).join('  '),
        };
      });
      if (items.length > rows.length) {
        rows.push({ kind: 'meta', text: `… ${items.length - rows.length} more completions` });
      }
      return rows;
    }
  }

  const rows: ToolVisualLine[] = [];
  let currentPath: string | undefined;
  let dropped = 0;
  const push = (line: ToolVisualLine): void => {
    if (rows.length < VISUAL_MAX_LINES) rows.push(line);
    else dropped += 1;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || line === 'Workspace edit:') continue;

    const fileHeader = line.match(/^(.+?) \((\d+)\):$/);
    if (fileHeader?.[1]) {
      currentPath = fileHeader[1];
      push({ kind: 'path', path: currentPath, text: `${fileHeader[2]} diagnostic(s)` });
      continue;
    }

    const diagnostic = line.match(/^\s*L(\d+):(\d+)\s+(ERROR|WARN|INFO|HINT)(?:\s+([^:]+))?:\s*(.*)$/);
    if (diagnostic) {
      const severity = diagnostic[3] ?? 'INFO';
      push({
        kind: severity === 'ERROR' ? 'error' : severity === 'WARN' ? 'warn' : 'code',
        marker: severity === 'ERROR' ? '× ' : severity === 'WARN' ? '! ' : '· ',
        lineNo: diagnostic[1],
        text: [diagnostic[4], diagnostic[5]].filter(Boolean).join('  '),
      });
      continue;
    }

    const location = line.match(/^(.+):(\d+):(\d+)$/);
    if (location?.[1]) {
      push({ kind: 'path', path: location[1], lineNo: location[2], text: `column ${location[3]}` });
      continue;
    }

    const edit = line.match(/^\s*(.+?)\s+(\d+)\s+edit\(s\)$/);
    if (edit?.[1]) {
      push({ kind: ok ? 'ok' : 'error', path: edit[1], text: `${edit[2]} edit(s)` });
      continue;
    }

    const completion = line.match(/^\s*\d+\.\s+(.+?)\s+\[([^\]]+)\](?:\s+—\s+(.*))?$/);
    if (completion) {
      push({
        kind: 'code',
        marker: glyphForLspKind(completion[2]),
        text: [completion[1], completion[2] ? `[${completion[2]}]` : '', completion[3]]
          .filter(Boolean)
          .join('  '),
      });
      continue;
    }

    if (/^(?:Total|Applied):/.test(line)) {
      push({ kind: ok ? 'ok' : 'error', marker: ok ? '✓ ' : '× ', text: line });
      continue;
    }

    if (/^No (?:LSP diagnostics|locations|completions)/i.test(line)) {
      push({ kind: 'meta', text: line });
      continue;
    }

    push({ kind: ok ? 'meta' : 'error', path: currentPath, text: line.trim() });
  }

  if (dropped > 0) {
    const overflow = { kind: 'meta' as const, text: `… ${dropped} more lines` };
    if (rows.length === VISUAL_MAX_LINES) rows[rows.length - 1] = overflow;
    else rows.push(overflow);
  }
  return rows.length > 0 ? rows : [{ kind: ok ? 'ok' : 'error', text }];
}

function glyphForLspKind(kind: string | undefined): string {
  if (!kind) return '· ';
  if (/method|function|constructor/i.test(kind)) return 'ƒ ';
  if (/class|interface|struct|type/i.test(kind)) return '◇ ';
  if (/field|property|variable|constant/i.test(kind)) return '◆ ';
  if (/file|folder|module/i.test(kind)) return '▣ ';
  return '· ';
}

export function ToolOutputLines({
  lines,
  hasFollowingBlock,
}: {
  lines: ToolVisualLine[];
  hasFollowingBlock?: boolean | undefined;
}): React.ReactElement {
  return (
    <>
      {lines.map((line, i) => {
        const branch = i === lines.length - 1 && !hasFollowingBlock ? '  └─ ' : '  ├─ ';
        const color = colorForVisualKind(line.kind);
        return (
          <Text key={`${line.kind}-${i}`}>
            <Text dimColor>{branch}</Text>
            {line.marker ? (
              <Text color={color} bold>
                {line.marker}
              </Text>
            ) : null}
            {line.path ? (
              <>
                <Text color="cyan">{shortenPath(line.path, 56)}</Text>
                <Text dimColor>{'  '}</Text>
              </>
            ) : null}
            {line.lineNo ? (
              <>
                <Text color="yellow">{String(line.lineNo).padStart(4, ' ')}</Text>
                <Text dimColor>{' │ '}</Text>
              </>
            ) : null}
            <Text color={color} dimColor={line.kind === 'meta' || line.kind === 'stdout'}>
              {truncMid(line.text, VISUAL_TEXT_BUDGET)}
            </Text>
          </Text>
        );
      })}
    </>
  );
}

function colorForVisualKind(kind: ToolVisualLineKind): string | undefined {
  switch (kind) {
    case 'ok':
      return 'green';
    case 'warn':
      return 'yellow';
    case 'error':
    case 'stderr':
      return 'red';
    case 'path':
    case 'match':
      return 'cyan';
    case 'code':
      return 'white';
    case 'stdout':
    case 'meta':
      return undefined;
  }
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
  const contiguous = Number.isFinite(first) && Number.isFinite(last)
    ? numbered.length === last - first + 1
    : true;
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
    const direct = line.match(/^(.+?):(\d+):(.*)$/);
    const grouped = line.match(/^(\d+):(.*)$/);
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
    const m = hit.match(/^(.+?):(\d+):(.*)$/);
    return m?.[1] && m[2] ? { path: m[1], line: m[2], text: m[3] ?? '' } : { text: hit };
  }
  if (hit && typeof hit === 'object') {
    const o = hit as Record<string, unknown>;
    const path = stringOf(o['file']) ?? stringOf(o['path']) ?? stringOf(o['url']);
    const line = numOf(o['line']) ?? numOf(o['lineNumber']);
    const title = stringOf(o['title']);
    const snippet = stringOf(o['snippet']);
    const text =
      stringOf(o['text']) ??
      stringOf(o['match']) ??
      stringOf(o['preview']) ??
      [title, snippet].filter(Boolean).join(' — ');
    return { path, line: line === undefined ? undefined : String(line), text };
  }
  return undefined;
}

function visualPathList(toolName: string, text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  const files =
    json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>)['files'])
      ? ((json as Record<string, unknown>)['files'] as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
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

function visualCommand(toolName: string, text: string, ok: boolean): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    return commandRows({
      exit: numOf(obj['exit_code']) ?? numOf(obj['exitCode']),
      timedOut: obj['timed_out'] === true || obj['timedOut'] === true,
      stdout: stringOf(obj['stdout']) ?? stringOf(obj['output']),
      stderr: stringOf(obj['stderr']) ?? stringOf(obj['error']),
      ok,
    });
  }

  const header = parseHeaderLine(text);
  const sections = parseNamedSections(text);
  return commandRows({
    exit:
      numberFromParsedField(header.fields, 'exit_code') ??
      numberFromParsedField(header.fields, 'exitCode'),
    timedOut: header.fields['timed_out'] === 'true' || header.fields['timedOut'] === 'true',
    stdout: sections.get('stdout') ?? sections.get('output'),
    stderr: sections.get('stderr') ?? sections.get('error'),
    ok,
    label: toolName,
  });
}

function commandRows(opts: {
  exit?: number | undefined;
  timedOut: boolean;
  stdout?: string | undefined;
  stderr?: string | undefined;
  ok: boolean;
  label?: string | undefined;
}): ToolVisualLine[] | undefined {
  const rows: ToolVisualLine[] = [];
  const statusKind: ToolVisualLineKind = opts.timedOut
    ? 'warn'
    : opts.ok && (opts.exit ?? 0) === 0
      ? 'ok'
      : 'error';
  const status = opts.timedOut
    ? 'timed out'
    : opts.exit !== undefined
      ? `exit ${opts.exit}`
      : opts.ok
        ? 'completed'
        : 'failed';
  rows.push({
    kind: statusKind,
    marker: statusKind === 'ok' ? 'ok ' : statusKind === 'warn' ? '! ' : 'x ',
    text: opts.label ? `${opts.label} ${status}` : status,
  });
  appendOutputPreview(rows, opts.stdout, 'stdout');
  appendOutputPreview(rows, opts.stderr, 'stderr');
  return rows.length > 0 ? rows.slice(0, VISUAL_MAX_LINES) : undefined;
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

function visualFetch(text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const status = numOf(obj['status']);
    const ct = stringOf(obj['content_type']);
    const content = stringOf(obj['content']);
    return fetchRows(status, ct, content);
  }
  const header = parseHeaderLine(text);
  return fetchRows(
    numberFromParsedField(header.fields, 'status'),
    header.fields['content_type'],
    bodyLines(text).join('\n'),
  );
}

function fetchRows(
  status: number | undefined,
  contentType: string | undefined,
  content: string | undefined,
): ToolVisualLine[] | undefined {
  const kind: ToolVisualLineKind =
    status === undefined
      ? 'meta'
      : status >= 200 && status < 300
        ? 'ok'
        : status >= 300 && status < 400
          ? 'warn'
          : 'error';
  const rows: ToolVisualLine[] = [
    {
      kind,
      marker: kind === 'ok' ? 'ok ' : kind === 'warn' ? '! ' : kind === 'error' ? 'x ' : undefined,
      text: [status !== undefined ? `HTTP ${status}` : 'HTTP', contentType?.split(';')[0]]
        .filter(Boolean)
        .join(' · '),
    },
  ];
  const preview = firstNonEmpty(content ?? '');
  if (preview) rows.push({ kind: 'stdout', text: preview });
  return rows;
}

function visualJson(text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const obj = json as Record<string, unknown>;
  const err = stringOf(obj['error']);
  if (err) return [{ kind: 'error', marker: 'x ', text: err }];
  const type = stringOf(obj['type']);
  const keys = Array.isArray(obj['keys']) ? obj['keys'].length : undefined;
  return [
    {
      kind: 'ok',
      marker: 'ok ',
      text: [type ?? 'json', keys !== undefined ? `${keys} key${keys === 1 ? '' : 's'}` : undefined]
        .filter(Boolean)
        .join(' · '),
    },
  ];
}

function visualOutdated(text: string): ToolVisualLine[] | undefined {
  const lines = bodyLines(text).filter((line) => line.trim() && !line.startsWith('outdated'));
  if (lines.length === 0) return undefined;
  return lines
    .slice(0, VISUAL_MAX_LINES)
    .map((line): ToolVisualLine => ({ kind: 'warn', marker: '! ', text: line }));
}

function visualAudit(text: string): ToolVisualLine[] | undefined {
  const lines = bodyLines(text).filter((line) => line.trim() && !line.startsWith('audit'));
  if (lines.length === 0) return undefined;
  return lines.slice(0, VISUAL_MAX_LINES).map(
    (line): ToolVisualLine => ({
      kind: /^critical|^high/i.test(line)
        ? 'error'
        : /^moderate|^medium/i.test(line)
          ? 'warn'
          : 'meta',
      marker: /^critical|^high/i.test(line)
        ? 'x '
        : /^moderate|^medium/i.test(line)
          ? '! '
          : undefined,
      text: line,
    }),
  );
}

function visualScaffold(text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (!json || typeof json !== 'object') return undefined;
  const obj = json as Record<string, unknown>;
  const created = Array.isArray(obj['created']) ? obj['created'] : [];
  const skipped = Array.isArray(obj['skipped']) ? obj['skipped'] : [];
  const rows: ToolVisualLine[] = [];
  for (const file of created.slice(0, 5)) {
    if (typeof file === 'string') rows.push({ kind: 'ok', marker: '+ ', path: file, text: '' });
  }
  if (skipped.length > 0)
    rows.push({ kind: 'warn', marker: '! ', text: `${skipped.length} skipped` });
  return rows.length > 0 ? rows : undefined;
}

/** Max board rows shown inside the todo tool card before collapsing to "… N more". */
const TODO_VISUAL_MAX_LINES = 10;

function visualTodo(text: string, input?: unknown): ToolVisualLine[] | undefined {
  // The tool OUTPUT only carries counts; the full replacement list lives in
  // the call INPUT. Render the actual board inside the tool card (above the
  // closing rail) so the transcript doesn't need a separate todo-list block.
  const inputObj =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const todos = Array.isArray(inputObj?.['todos']) ? inputObj['todos'] : undefined;
  const items = (todos ?? []).filter(
    (t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object' && !Array.isArray(t),
  );
  if (items.length > 0) {
    const rows: ToolVisualLine[] = items.slice(0, TODO_VISUAL_MAX_LINES).map((o): ToolVisualLine => {
      const content = stringOf(o['content']) ?? stringOf(o['id']) ?? 'todo';
      const status = stringOf(o['status']);
      if (status === 'completed') return { kind: 'ok', marker: '[x] ', text: content };
      if (status === 'in_progress') {
        return { kind: 'warn', marker: '[~] ', text: stringOf(o['activeForm']) ?? content };
      }
      return { kind: 'meta', marker: '[ ] ', text: content };
    });
    if (items.length > rows.length) {
      rows.push({ kind: 'meta', text: `… ${items.length - rows.length} more` });
    }
    return rows;
  }

  const json = tryParseJson(text);
  const fields =
    json && typeof json === 'object' && !Array.isArray(json)
      ? recordToStringFields(json as Record<string, unknown>)
      : parseHeaderLine(text).fields;
  const count = numberFromParsedField(fields, 'count') ?? 0;
  const inProgress = numberFromParsedField(fields, 'in_progress') ?? 0;
  return [
    {
      kind: count > 0 ? 'ok' : 'meta',
      marker: count > 0 ? 'ok ' : undefined,
      text: `${count} todo${count === 1 ? '' : 's'}${inProgress > 0 ? ` · ${inProgress} in progress` : ''}`,
    },
  ];
}

function visualWorkBoard(
  toolName: string,
  text: string,
  ok: boolean,
): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    const rows = boardSummaryRows(toolName, recordToStringFields(obj), ok);
    appendBoardPreview(rows, stringOf(obj['message']));
    appendBoardPreview(rows, stringOf(obj['plan']));
    const todos = Array.isArray(obj['todos']) ? obj['todos'] : [];
    for (const todo of todos.slice(0, 3)) {
      if (todo && typeof todo === 'object') {
        const o = todo as Record<string, unknown>;
        rows.push({
          kind: 'path',
          marker: '+ ',
          text: stringOf(o['content']) ?? stringOf(o['id']) ?? 'todo',
        });
      }
    }
    return rows.slice(0, VISUAL_MAX_LINES);
  }

  const header = parseHeaderLine(text);
  const sections = parseNamedSections(text);
  const rows = boardSummaryRows(toolName, header.fields, ok);
  appendBoardPreview(
    rows,
    sections.get('message') ?? sections.get('plan') ?? bodyLines(text).join('\n'),
  );
  return rows.slice(0, VISUAL_MAX_LINES);
}

function boardSummaryRows(
  toolName: string,
  fields: Record<string, string>,
  ok: boolean,
): ToolVisualLine[] {
  const success = fields['ok'] !== 'false' && ok;
  const count = numberFromParsedField(fields, 'count');
  const open = numberFromParsedField(fields, 'open');
  const completed = numberFromParsedField(fields, 'completed');
  const inProgress =
    numberFromParsedField(fields, 'inProgress') ?? numberFromParsedField(fields, 'in_progress');
  const parts = [
    toolName,
    count !== undefined ? `${count} item${count === 1 ? '' : 's'}` : undefined,
    open !== undefined ? `${open} open` : undefined,
    completed !== undefined ? `${completed} done` : undefined,
    inProgress !== undefined && inProgress > 0 ? `${inProgress} in progress` : undefined,
  ].filter(Boolean);
  return [
    {
      kind: success ? 'ok' : 'error',
      marker: success ? 'ok ' : 'x ',
      text: parts.join(' · ') || toolName,
    },
  ];
}

function appendBoardPreview(rows: ToolVisualLine[], text: string | undefined): void {
  if (!text) return;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s│├└─>*-]+/, '').trim())
    .filter((line) => line && !line.startsWith('{') && !line.startsWith('['));
  for (const line of lines.slice(0, 4)) {
    rows.push({
      kind: line.includes('failed') || line.includes('not configured') ? 'error' : 'meta',
      text: line,
    });
  }
}

function visualMemory(toolName: string, text: string, ok: boolean): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    if (toolName === 'search_memory' || toolName === 'find_related_memories') {
      return memoryResultRows(Array.isArray(obj['results']) ? obj['results'] : []);
    }
    const fields = recordToStringFields(obj);
    return [memoryStatusRow(toolName, fields, ok)];
  }

  const header = parseHeaderLine(text);
  if (toolName === 'search_memory' || toolName === 'find_related_memories') {
    return memoryResultRows(bodyLines(text));
  }
  return [memoryStatusRow(toolName, header.fields, ok)];
}

function memoryStatusRow(
  toolName: string,
  fields: Record<string, string>,
  ok: boolean,
): ToolVisualLine {
  const scope = fields['scope'];
  const removed = numberFromParsedField(fields, 'removed');
  const text =
    toolName === 'forget'
      ? `${removed ?? 0} removed${scope ? ` · ${scope}` : ''}`
      : `${toolName}${scope ? ` · ${scope}` : ''}`;
  return { kind: ok ? 'ok' : 'error', marker: ok ? 'ok ' : 'x ', text };
}

function memoryResultRows(results: unknown[]): ToolVisualLine[] | undefined {
  if (results.length === 0) return [{ kind: 'meta', text: 'no memories' }];
  const rows: ToolVisualLine[] = [];
  for (const result of results.slice(0, VISUAL_MAX_LINES)) {
    if (typeof result === 'string') {
      const parsed = tryParseJson(result);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        rows.push({
          kind: 'meta',
          marker: tagMarker(stringOf(o['priority'])),
          text: memoryText(o),
        });
      } else {
        rows.push({ kind: 'meta', text: result });
      }
    } else if (result && typeof result === 'object') {
      const o = result as Record<string, unknown>;
      rows.push({ kind: 'meta', marker: tagMarker(stringOf(o['priority'])), text: memoryText(o) });
    }
  }
  if (results.length > rows.length)
    rows.push({ kind: 'meta', text: `${results.length - rows.length} more memory result(s)` });
  return rows;
}

function memoryText(o: Record<string, unknown>): string {
  const type = stringOf(o['type']);
  const scope = stringOf(o['scope']);
  const text = stringOf(o['text']) ?? '';
  return [type ? `[${type}]` : undefined, scope, text].filter(Boolean).join(' ');
}

function tagMarker(priority: string | undefined): string | undefined {
  if (priority === 'critical' || priority === 'high') return '! ';
  return undefined;
}

function visualLogs(text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    const rows: ToolVisualLine[] = [
      {
        kind: 'meta',
        text: `${stringOf(obj['source']) ?? 'logs'} · ${numOf(obj['total']) ?? 0} entries${obj['truncated'] === true ? ' · truncated' : ''}`,
      },
    ];
    const entries = Array.isArray(obj['entries']) ? obj['entries'] : [];
    appendLogEntries(rows, entries);
    return rows;
  }
  const header = parseHeaderLine(text);
  const rows: ToolVisualLine[] = [
    {
      kind: 'meta',
      text: `${header.label}${header.fields['total'] ? ` · ${header.fields['total']} entries` : ''}`,
    },
  ];
  appendLogEntries(rows, bodyLines(text));
  return rows.slice(0, VISUAL_MAX_LINES);
}

function appendLogEntries(rows: ToolVisualLine[], entries: unknown[]): void {
  for (const entry of entries.slice(0, 5)) {
    if (typeof entry === 'string') {
      rows.push(logLine(entry));
    } else if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      rows.push(
        logLine(
          [
            stringOf(o['timestamp']),
            stringOf(o['level']),
            stringOf(o['source']),
            stringOf(o['message']),
          ]
            .filter(Boolean)
            .join(' '),
        ),
      );
    }
  }
  if (entries.length > 5)
    rows.push({ kind: 'meta', text: `${entries.length - 5} more log line(s)` });
}

function logLine(line: string): ToolVisualLine {
  const kind: ToolVisualLineKind = /\b(error|fatal|panic)\b/i.test(line)
    ? 'error'
    : /\b(warn|warning)\b/i.test(line)
      ? 'warn'
      : 'stdout';
  return { kind, marker: kind === 'error' ? 'x ' : kind === 'warn' ? '! ' : undefined, text: line };
}

function visualDocument(text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  const rows: ToolVisualLine[] = [];
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    rows.push({
      kind: 'ok',
      marker: 'ok ',
      text: `${numOf(obj['items_documented']) ?? 0} documented · ${numOf(obj['files_processed']) ?? 0} files · ${stringOf(obj['style']) ?? 'style'}`,
    });
    appendDocumentResults(rows, Array.isArray(obj['results']) ? obj['results'] : []);
    return rows.slice(0, VISUAL_MAX_LINES);
  }
  const header = parseHeaderLine(text);
  rows.push({
    kind: 'ok',
    marker: 'ok ',
    text: `${header.fields['items_documented'] ?? '0'} documented · ${header.fields['files_processed'] ?? '0'} files`,
  });
  appendDocumentResults(rows, bodyLines(text));
  return rows.slice(0, VISUAL_MAX_LINES);
}

function appendDocumentResults(rows: ToolVisualLine[], results: unknown[]): void {
  for (const result of results.slice(0, 5)) {
    const obj = typeof result === 'string' ? tryParseJson(result) : result;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>;
      const status = stringOf(o['status']) ?? 'item';
      rows.push({
        kind: status === 'error' ? 'error' : status === 'skipped' ? 'warn' : 'path',
        marker: status === 'error' ? 'x ' : status === 'skipped' ? '! ' : '+ ',
        path: stringOf(o['path']),
        text: stringOf(o['name']) ?? stringOf(o['signature']) ?? status,
      });
    } else if (typeof result === 'string' && result.trim()) {
      rows.push({ kind: 'meta', text: result.trim() });
    }
  }
}

function visualToolCatalog(toolName: string, text: string): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  const rows: ToolVisualLine[] = [];
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    const total = numOf(obj['total']) ?? 0;
    rows.push({
      kind: total > 0 ? 'ok' : 'warn',
      marker: total > 0 ? 'ok ' : '! ',
      text: `${toolName} · ${total} result${total === 1 ? '' : 's'}`,
    });
    const tools = Array.isArray(obj['tools']) ? obj['tools'] : [];
    for (const tool of tools.slice(0, 5)) {
      if (tool && typeof tool === 'object') {
        const o = tool as Record<string, unknown>;
        rows.push({
          kind: o['mutating'] === true ? 'warn' : 'path',
          marker: o['mutating'] === true ? '! ' : undefined,
          text: [stringOf(o['name']), stringOf(o['permission']), stringOf(o['description'])]
            .filter(Boolean)
            .join(' · '),
        });
      }
    }
    return rows.slice(0, VISUAL_MAX_LINES);
  }
  const header = parseHeaderLine(text);
  return [{ kind: 'meta', text: header.label || toolName }];
}

function visualMetaExecution(
  toolName: string,
  text: string,
  ok: boolean,
): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    const header = parseHeaderLine(text);
    return [
      { kind: ok ? 'ok' : 'error', marker: ok ? 'ok ' : 'x ', text: header.label || toolName },
    ];
  }
  const obj = json as Record<string, unknown>;
  if (toolName === 'tool_use') {
    const success = obj['success'] !== false && ok;
    const target = stringOf(obj['tool']) ?? 'tool';
    return [
      {
        kind: success ? 'ok' : 'error',
        marker: success ? 'ok ' : 'x ',
        text: `${target} · ${numOf(obj['executionMs']) ?? 0}ms${success ? '' : ` · ${stringOf(obj['error']) ?? 'failed'}`}`,
      },
    ];
  }
  const total = numOf(obj['total']) ?? 0;
  const succeeded = numOf(obj['succeeded']) ?? 0;
  const failed = numOf(obj['failed']) ?? 0;
  const rows: ToolVisualLine[] = [
    {
      kind: failed > 0 || !ok ? 'error' : 'ok',
      marker: failed > 0 || !ok ? 'x ' : 'ok ',
      text: `${succeeded}/${total} succeeded${failed > 0 ? ` · ${failed} failed` : ''}`,
    },
  ];
  const results = Array.isArray(obj['results']) ? obj['results'] : [];
  for (const result of results.slice(0, 5)) {
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      const success = r['success'] !== false;
      rows.push({
        kind: success ? 'ok' : 'error',
        marker: success ? 'ok ' : 'x ',
        text: `${stringOf(r['tool']) ?? 'tool'} · ${numOf(r['executionMs']) ?? 0}ms${success ? '' : ` · ${stringOf(r['error']) ?? 'failed'}`}`,
      });
    }
  }
  return rows.slice(0, VISUAL_MAX_LINES);
}

function visualCodebase(toolName: string, text: string, ok: boolean): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    const header = parseHeaderLine(text);
    return [
      { kind: ok ? 'ok' : 'warn', marker: ok ? 'ok ' : '! ', text: header.label || toolName },
    ];
  }
  const obj = json as Record<string, unknown>;
  if (toolName === 'codebase-search') {
    const status = stringOf(obj['indexStatus']);
    const total = numOf(obj['total']) ?? 0;
    const rows: ToolVisualLine[] = [
      {
        kind: status ? 'warn' : 'ok',
        marker: status ? '! ' : 'ok ',
        text:
          status ??
          `${total} symbol result${total === 1 ? '' : 's'} for "${stringOf(obj['query']) ?? ''}"`,
      },
    ];
    const results = Array.isArray(obj['results']) ? obj['results'] : [];
    for (const result of results.slice(0, 5)) {
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        rows.push({
          kind: 'match',
          path: stringOf(r['file']),
          lineNo: numOf(r['line'])?.toString(),
          text: [stringOf(r['kind']), stringOf(r['name']), stringOf(r['signature'])]
            .filter(Boolean)
            .join(' · '),
        });
      }
    }
    return rows.slice(0, VISUAL_MAX_LINES);
  }
  if (toolName === 'codebase-index') {
    const errors = Array.isArray(obj['errors']) ? obj['errors'] : [];
    return [
      {
        kind: errors.length > 0 || !ok ? 'error' : stringOf(obj['note']) ? 'warn' : 'ok',
        marker: errors.length > 0 || !ok ? 'x ' : stringOf(obj['note']) ? '! ' : 'ok ',
        text:
          stringOf(obj['note']) ??
          `${numOf(obj['filesIndexed']) ?? 0} files · ${numOf(obj['symbolsIndexed']) ?? 0} symbols · ${fmtDuration(numOf(obj['durationMs']) ?? 0)}`,
      },
    ];
  }
  const status = stringOf(obj['indexStatus']);
  return [
    {
      kind: status ? 'warn' : 'ok',
      marker: status ? '! ' : 'ok ',
      text:
        status ??
        `${numOf(obj['totalSymbols']) ?? 0} symbols · ${numOf(obj['totalFiles']) ?? 0} files · ${fmtBytes(numOf(obj['sizeBytes']) ?? 0)}`,
    },
  ];
}

function visualWorkingDir(text: string, ok: boolean): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  const obj =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined;
  if (!obj) return undefined;
  const err = stringOf(obj['error']);
  return [
    {
      kind: err || !ok ? 'error' : 'ok',
      marker: err || !ok ? 'x ' : 'ok ',
      path: stringOf(obj['current']),
      text: err ?? stringOf(obj['message']) ?? 'working directory',
    },
  ];
}

function visualMode(text: string, ok: boolean): ToolVisualLine[] | undefined {
  const json = tryParseJson(text);
  const obj =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined;
  if (!obj) return undefined;
  if (Array.isArray(obj['modes'])) {
    const modes = obj['modes'] as unknown[];
    const rows: ToolVisualLine[] = [
      { kind: 'ok', marker: 'ok ', text: `${modes.length} mode${modes.length === 1 ? '' : 's'}` },
    ];
    for (const mode of modes.slice(0, 5)) {
      if (mode && typeof mode === 'object') {
        const m = mode as Record<string, unknown>;
        rows.push({
          kind: 'path',
          text: [stringOf(m['id']), stringOf(m['name']), stringOf(m['description'])]
            .filter(Boolean)
            .join(' · '),
        });
      }
    }
    return rows;
  }
  const success = obj['success'] !== false && ok;
  return [
    {
      kind: success ? 'ok' : 'error',
      marker: success ? 'ok ' : 'x ',
      text: [
        stringOf(obj['action']) ?? 'mode',
        stringOf(obj['currentMode']),
        stringOf(obj['message']),
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];
}

function recordToStringFields(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    }
  }
  return out;
}

function appendOutputPreview(
  rows: ToolVisualLine[],
  output: string | undefined,
  kind: 'stdout' | 'stderr',
): void {
  if (!output) return;
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  for (const line of lines.slice(0, 3)) rows.push({ kind, text: line.trim() });
  if (lines.length > 3)
    rows.push({ kind: 'meta', text: `${lines.length - 3} more ${kind} line(s)` });
}

function bodyLines(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length > 0 && /^[^\n]+(?:\s+\([^)]*\))?$/.test(lines[0] ?? '')) {
    return lines.slice(1);
  }
  return lines;
}

function parseHeaderLine(text: string): { label: string; fields: Record<string, string> } {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const match = first.match(/^(.+?)(?: \((.*)\))?$/);
  const label = match?.[1] ?? first;
  const rawFields = match?.[2] ?? '';
  return { label, fields: parseInlineFields(rawFields) };
}

function parseInlineFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=([^ ]+)/g)) {
    if (match[1] && match[2]) fields[match[1]] = match[2];
  }
  return fields;
}

function parseNamedSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.replace(/\r/g, '').split('\n');
  let current: string | undefined;
  const buf: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buf.join('\n').trim());
    buf.length = 0;
  };
  for (const line of lines.slice(1)) {
    const m = line.match(/^([a-z_]+):$/);
    if (m?.[1]) {
      flush();
      current = m[1];
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return sections;
}

function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m?.[1]) out[m[1]] = m[2] ?? '';
  }
  return out;
}

function numberFromParsedField(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ============================================
// Streaming tool output component
// ============================================

export const MAX_STREAM_DISPLAY_CHARS = 480;
const MAX_STREAM_LINES = 8;
const WRITE_CREATE_STREAM_LINES = 3;
const TOOL_STREAM_MARGIN_ROWS = 2;
const TOOL_STREAM_HEADER_ROWS = 1;

/** Fixed layout height of the live tool-stream tail for scroll-range math. */
export function toolStreamBoxHeight(name: string): number {
  const contentRows = name === 'write' ? WRITE_CREATE_STREAM_LINES : MAX_STREAM_LINES;
  return TOOL_STREAM_MARGIN_ROWS + TOOL_STREAM_HEADER_ROWS + contentRows;
}

/**
 * Build the CONSTANT-height content block for the live tool-stream box: always
 * exactly `maxLines` rows, newest-pinned-to-bottom, every line truncated to
 * `contentWidth` so nothing wraps. Holding the row count fixed is what stops the
 * live region from growing (and thus scrolling the terminal + leaking the header
 * into scrollback) as output streams in. Pure + exported for testing.
 */
export function streamBoxRows(
  text: string,
  maxLines: number,
  contentWidth: number,
): Array<{ text: string; italic?: boolean | undefined }> {
  const trunc = (line: string) =>
    line.length > contentWidth ? `${line.slice(0, contentWidth - 1)}…` : line;
  const lines = text.split('\n');
  const totalLines = lines.length;
  const hidden = Math.max(0, totalLines - maxLines);
  const rows: Array<{ text: string; italic?: boolean | undefined }> = [];
  if (hidden > 0) {
    rows.push({ text: `  … ${hidden} more line${hidden === 1 ? '' : 's'} above`, italic: true });
    for (const line of lines.slice(totalLines - (maxLines - 1))) rows.push({ text: trunc(line) });
  } else {
    for (let i = 0; i < maxLines - totalLines; i++) rows.push({ text: '' });
    for (const line of lines) rows.push({ text: trunc(line) });
  }
  return rows;
}

export const ToolStreamBox = React.memo(function ToolStreamBox({
  name,
  text,
  startedAt,
  termWidth,
}: {
  name: string;
  text: string;
  startedAt: number;
  termWidth: number;
}): React.ReactElement {
  const { glyph, color } = getToolVisual(name);
  // This box only exists for an active tool; share its elapsed-time clock with
  // every other Ink animation instead of owning another interval.
  useAnimation({ interval: 1_000 });

  const elapsedMs = Date.now() - startedAt;
  const streamLines = name === 'write' ? WRITE_CREATE_STREAM_LINES : MAX_STREAM_LINES;
  const totalLines = text.split('\n').length;
  const hidden = Math.max(0, totalLines - streamLines);
  const contentWidth = Math.max(20, Math.min(termWidth - 4, 100));
  // Constant-height content block (see streamBoxRows): the live region must not
  // grow row-by-row as output streams, or it scrolls the terminal and leaks the
  // "◆ <tool> ⏱ …" header into scrollback on every update in inline mode.
  const rows = streamBoxRows(text, streamLines, contentWidth);
  const isWritePreview = name === 'write';

  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={color}
      paddingLeft={1}
    >
      <Box flexDirection="row">
        <Text color={color}>{glyph} </Text>
        <Text bold color={color}>
          {isWritePreview ? 'write · creating file' : name}
        </Text>
        <Text dimColor>{`  ⏱ ${fmtDuration(elapsedMs)}`}</Text>
        {hidden > 0 ? (
          <Text dimColor>{`  (${totalLines} lines, showing last ${streamLines})`}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginLeft={1}>
        {rows.map((r, i) => (
          <Text key={i} color={isWritePreview ? 'gray' : undefined} dimColor={!isWritePreview} italic={Boolean(r.italic)}>
            {r.text || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
});

export function tailForDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  const nl = text.indexOf('\n', cut);
  if (nl !== -1 && nl < cut + 80) {
    return `… ${text.slice(nl + 1)}`;
  }
  return `… ${text.slice(cut)}`;
}
