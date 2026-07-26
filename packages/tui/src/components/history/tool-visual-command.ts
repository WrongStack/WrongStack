import { numOf, stringOf, tryParseJson } from './basic-format.js';
import {
  appendOutputPreview,
  numberFromParsedField,
  parseHeaderLine,
  parseNamedSections,
} from './tool-visual-format.js';
import type { ToolVisualLine, ToolVisualLineKind } from './utils.js';

const VISUAL_MAX_LINES = 7;

export function visualCommand(
  toolName: string,
  text: string,
  ok: boolean,
): ToolVisualLine[] | undefined {
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
