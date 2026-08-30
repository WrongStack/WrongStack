import { fmtBytes, fmtDuration, numOf, stringOf, tryParseJson } from './basic-format.js';
import {
  bodyLines,
  numberFromParsedField,
  parseHeaderLine,
  parseNamedSections,
  recordToStringFields,
} from './tool-visual-format.js';
import type { ToolVisualLine } from './tool-visual-types.js';

const VISUAL_MAX_LINES = 7;
const TODO_VISUAL_MAX_LINES = 10;

export function visualTodo(text: string, input?: unknown): ToolVisualLine[] | undefined {
  const inputObj =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const todos = Array.isArray(inputObj?.['todos']) ? inputObj['todos'] : undefined;
  const items = (todos ?? []).filter(
    (t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object' && !Array.isArray(t),
  );
  if (items.length > 0) {
    const rows: ToolVisualLine[] = items
      .slice(0, TODO_VISUAL_MAX_LINES)
      .map((o): ToolVisualLine => {
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

export function visualWorkBoard(
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

export function visualDocument(text: string): ToolVisualLine[] | undefined {
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

export function visualToolCatalog(toolName: string, text: string): ToolVisualLine[] | undefined {
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

export function visualMetaExecution(
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

export function visualCodebase(
  toolName: string,
  text: string,
  ok: boolean,
): ToolVisualLine[] | undefined {
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
  if (toolName === 'codebase-incoming-calls' || toolName === 'codebase-outgoing-calls') {
    const total = numOf(obj['total']) ?? (Array.isArray(obj['calls']) ? obj['calls'].length : 0);
    const targetSymbol = stringOf(obj['symbol']) ?? '';
    const label =
      toolName === 'codebase-incoming-calls'
        ? `${total} caller${total === 1 ? '' : 's'} for "${targetSymbol}"`
        : `${total} outgoing call${total === 1 ? '' : 's'} from "${targetSymbol}"`;
    const rows: ToolVisualLine[] = [
      {
        kind: 'ok',
        marker: 'ok ',
        text: label,
      },
    ];
    const calls = Array.isArray(obj['calls']) ? obj['calls'] : [];
    for (const call of calls.slice(0, 5)) {
      if (call && typeof call === 'object') {
        const c = call as Record<string, unknown>;
        const sym =
          c['symbol'] && typeof c['symbol'] === 'object'
            ? (c['symbol'] as Record<string, unknown>)
            : undefined;
        const file = stringOf(sym?.['file']) ?? stringOf(c['file']);
        const line = numOf(sym?.['line']) ?? numOf(c['line']);
        const name = stringOf(sym?.['name']) ?? stringOf(c['name']);
        const sig = stringOf(sym?.['signature']) ?? stringOf(c['signature']);
        const callType = stringOf(c['callType']);
        rows.push({
          kind: 'match',
          path: file,
          lineNo: line?.toString(),
          text: [name, callType ? `[${callType}]` : undefined, sig]
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
