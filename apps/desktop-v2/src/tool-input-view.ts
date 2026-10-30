import { record } from './engine-values';

export type ToolInputView =
  | { kind: 'edit'; path: string; removed: string[]; added: string[]; all: boolean }
  | { kind: 'write'; path: string; lines: string[]; more: number }
  | { kind: 'command'; command: string; cwd: string }
  | { kind: 'generic' };

/** Lines shown for a file written in full; the rest is counted. */
export const WRITE_PREVIEW_LINES = 40;

/**
 * A readable view of a known tool's input: an edit as removed/added lines, a full write as a
 * content preview, a shell call as its command. Anything else (or a malformed input) keeps the
 * generic structured view.
 */
export function toolInputView(name: string, input: unknown): ToolInputView {
  const value = record(input);
  const path = typeof value['path'] === 'string' ? value['path'] : '';
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
    return {
      kind: 'command',
      command: value['command'],
      cwd: typeof value['cwd'] === 'string' ? value['cwd'] : '',
    };
  return { kind: 'generic' };
}
