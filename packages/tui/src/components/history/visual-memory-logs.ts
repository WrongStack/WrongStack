import { numOf, stringOf, tryParseJson } from './basic-format.js';
import type { ToolVisualLine, ToolVisualLineKind } from './utils.js';

const VISUAL_MAX_LINES = 7;

export function visualMemory(
  toolName: string,
  text: string,
  ok: boolean,
): ToolVisualLine[] | undefined {
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

export function visualLogs(text: string): ToolVisualLine[] | undefined {
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

function numberFromParsedField(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}
