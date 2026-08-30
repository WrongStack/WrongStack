import { stringOf, tryParseJson } from './basic-format.js';
import type { ToolVisualLine } from './tool-visual-types.js';

const VISUAL_MAX_LINES = 7;

/** Turn the compact text emitted by plug-lsp into navigable, severity-aware rows. */
export function visualLsp(toolName: string, text: string, ok: boolean): ToolVisualLine[] {
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

    const diagnostic = line.match(
      /^\s*L(\d+):(\d+)\s+(ERROR|WARN|INFO|HINT)(?:\s+([^:]+))?:\s*(.*)$/,
    );
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

    const location = line.match(/^((?:[A-Za-z]:)?[^:]+):(\d+):(\d+)$/);
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
