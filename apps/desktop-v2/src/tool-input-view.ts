import { record } from './engine-values';

export type ToolInputView =
  | { kind: 'edit'; path: string; removed: string[]; added: string[]; all: boolean }
  | { kind: 'write'; path: string; lines: string[]; more: number }
  | { kind: 'command'; command: string; cwd: string }
  | { kind: 'read'; path: string; range: string }
  | { kind: 'search'; tool: 'grep' | 'glob'; pattern: string; path: string; details: string[] }
  | {
      kind: 'replace';
      pattern: string;
      replacement: string;
      files: string[];
      details: string[];
    }
  | { kind: 'generic' };

/** Lines shown for a file written in full; the rest is counted. */
export const WRITE_PREVIEW_LINES = 40;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** A shell argument shown as typed: quoted only when it would otherwise split or mislead. */
function shellArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * A readable view of a known tool's input: an edit as removed/added lines, a full write as a
 * content preview, a shell or exec call as its command line, a read as its path and line range,
 * a search as its pattern and scope, and a replace as its pattern, replacement and files.
 * Anything else (or a malformed input) keeps the generic structured view.
 */
export function toolInputView(name: string, input: unknown): ToolInputView {
  const value = record(input);
  const path = text(value['path']);
  if (
    name === 'edit' &&
    path &&
    typeof value['old_string'] === 'string' &&
    typeof value['new_string'] === 'string'
  )
    return {
      kind: 'edit',
      path,
      removed: value['old_string'] ? value['old_string'].split('\n') : [],
      added: value['new_string'] ? value['new_string'].split('\n') : [],
      all: value['replace_all'] === true,
    };
  if (name === 'write' && path && typeof value['content'] === 'string') {
    const lines = value['content'].split('\n');
    return {
      kind: 'write',
      path,
      lines: lines.slice(0, WRITE_PREVIEW_LINES),
      more: Math.max(0, lines.length - WRITE_PREVIEW_LINES),
    };
  }
  if (name === 'bash' && typeof value['command'] === 'string')
    return { kind: 'command', command: value['command'], cwd: text(value['cwd']) };
  if (name === 'exec' && typeof value['command'] === 'string') {
    const args = Array.isArray(value['args'])
      ? value['args'].filter((arg): arg is string => typeof arg === 'string')
      : [];
    return {
      kind: 'command',
      command: [value['command'], ...args.map(shellArg)].join(' '),
      cwd: text(value['cwd']),
    };
  }
  if (name === 'read' && path) {
    const offset = count(value['offset']);
    const limit = count(value['limit']);
    const range =
      offset !== undefined && limit !== undefined
        ? `lines ${offset}–${offset + limit - 1}`
        : offset !== undefined
          ? `from line ${offset}`
          : limit !== undefined
            ? `first ${limit} lines`
            : 'whole file';
    return { kind: 'read', path, range };
  }
  if ((name === 'grep' || name === 'glob') && typeof value['pattern'] === 'string') {
    const details = [
      text(value['glob']) && `files ${text(value['glob'])}`,
      text(value['output_mode']) && `mode ${text(value['output_mode'])}`,
      value['case_insensitive'] === true ? 'ignore case' : '',
      count(value['context_lines']) !== undefined ? `±${count(value['context_lines'])} lines` : '',
      count(value['limit']) !== undefined ? `limit ${count(value['limit'])}` : '',
    ].filter(Boolean);
    return { kind: 'search', tool: name, pattern: value['pattern'], path, details };
  }
  if (
    name === 'replace' &&
    typeof value['pattern'] === 'string' &&
    typeof value['replacement'] === 'string'
  ) {
    const files = Array.isArray(value['files'])
      ? value['files'].filter((file): file is string => typeof file === 'string')
      : typeof value['files'] === 'string'
        ? [value['files']]
        : [];
    const details = [
      text(value['glob']) && `files ${text(value['glob'])}`,
      value['replace_all'] === true ? 'every match' : '',
      // The tool previews unless told otherwise, so only an explicit false writes.
      value['dry_run'] === false ? 'writes files' : 'preview only',
    ].filter(Boolean);
    return {
      kind: 'replace',
      pattern: value['pattern'],
      replacement: value['replacement'],
      files,
      details,
    };
  }
  return { kind: 'generic' };
}
