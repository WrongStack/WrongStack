import { firstNonEmpty, numOf, stringOf, tryParseJson } from './basic-format.js';
import { bodyLines, numberFromParsedField, parseHeaderLine } from './tool-visual-format.js';
import type { ToolVisualLine, ToolVisualLineKind } from './tool-visual-types.js';

const VISUAL_MAX_LINES = 7;

export function visualFetch(text: string): ToolVisualLine[] | undefined {
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

export function visualJson(text: string): ToolVisualLine[] | undefined {
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

export function visualOutdated(text: string): ToolVisualLine[] | undefined {
  const lines = bodyLines(text).filter((line) => line.trim() && !line.startsWith('outdated'));
  if (lines.length === 0) return undefined;
  return lines
    .slice(0, VISUAL_MAX_LINES)
    .map((line): ToolVisualLine => ({ kind: 'warn', marker: '! ', text: line }));
}

export function visualAudit(text: string): ToolVisualLine[] | undefined {
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

export function visualScaffold(text: string): ToolVisualLine[] | undefined {
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
