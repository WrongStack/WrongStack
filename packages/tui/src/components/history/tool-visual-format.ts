import { sanitizeTerminalText } from '../../terminal-width.js';
import type { ToolVisualLine } from './tool-visual-types.js';

export function recordToStringFields(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    }
  }
  return out;
}

export function appendOutputPreview(
  rows: ToolVisualLine[],
  output: string | undefined,
  kind: 'stdout' | 'stderr',
): void {
  if (!output) return;
  const lines = sanitizeTerminalText(output)
    .split('\n')
    .filter((line) => line.trim());
  for (const line of lines.slice(0, 3)) rows.push({ kind, text: line.trim() });
  if (lines.length > 3)
    rows.push({ kind: 'meta', text: `${lines.length - 3} more ${kind} line(s)` });
}

export function bodyLines(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length > 1 && /^[^\s()]+\s+\([^)]*=[^)]*\)$/.test(lines[0] ?? '')) {
    return lines.slice(1);
  }
  return lines;
}

export function parseHeaderLine(text: string): { label: string; fields: Record<string, string> } {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const match = first.match(/^(.+?)(?: \((.*)\))?$/);
  const label = match?.[1] ?? first;
  const rawFields = match?.[2] ?? '';
  return { label, fields: parseInlineFields(rawFields) };
}

export function parseInlineFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=([^ ]+)/g)) {
    if (match[1] && match[2]) fields[match[1]] = match[2];
  }
  return fields;
}

export function parseNamedSections(text: string): Map<string, string> {
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

export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m?.[1]) out[m[1]] = m[2] ?? '';
  }
  return out;
}

export function numberFromParsedField(
  fields: Record<string, string>,
  key: string,
): number | undefined {
  const raw = fields[key];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}
