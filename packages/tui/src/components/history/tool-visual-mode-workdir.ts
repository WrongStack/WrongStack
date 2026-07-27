import { stringOf, tryParseJson } from './basic-format.js';
import type { ToolVisualLine } from './tool-visual-types.js';

export function visualWorkingDir(text: string, ok: boolean): ToolVisualLine[] | undefined {
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

export function visualMode(text: string, ok: boolean): ToolVisualLine[] | undefined {
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
