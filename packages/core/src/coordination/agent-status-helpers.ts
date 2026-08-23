/**
 * Pure projection helpers for {@link AgentStatusTracker}.
 *
 * Everything here turns raw event-payload shapes into the bounded, snapshot-safe
 * values the SessionRegistry stores: compacted tool inputs, completed-tool
 * receipts, and rolling activity totals. No I/O, no tracker state — split out of
 * `agent-status-tracker.ts` so the tracker file is just the event wiring.
 *
 * @module agent-status-helpers
 */
import type {
  AgentActivityTotals,
  AgentRecentMail,
  AgentRecentTool,
  AgentTodoItem,
} from '../session-catalog/session-registry.js';

/** Registry snapshots must stay small even when a tool receives a large patch. */
const TOOL_TEXT_CAP = 360;
const TOUCHED_FILE_LIMIT = 200;
const TODO_TEXT_CAP = 360;
const TODO_LIMIT = 32;

export interface PendingTool {
  name: string;
  input?: unknown | undefined;
  startedAt: number;
}

export interface CompletedToolPayload {
  id?: string | undefined;
  name: string;
  durationMs?: number | undefined;
  ok?: boolean | undefined;
  input?: unknown | undefined;
  output?: string | undefined;
  outputLines?: number | undefined;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function patchDelta(value: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  const hunkStart = value.indexOf('@@');
  if (hunkStart === -1) return { addedLines, removedLines };
  for (const line of value.slice(hunkStart).split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) addedLines += 1;
    else if (line.startsWith('-')) removedLines += 1;
  }
  return { addedLines, removedLines };
}

function compactText(value: string): string {
  return value.length <= TOOL_TEXT_CAP ? value : `${value.slice(0, TOOL_TEXT_CAP - 1)}…`;
}

export function boundedText(value: string, cap: number): string {
  const trimmed = value.trim();
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap - 1)}…`;
}

export function compactTodos(value: unknown): AgentTodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: AgentTodoItem[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const todo = candidate as Record<string, unknown>;
    const id = typeof todo['id'] === 'string' ? todo['id'].trim() : '';
    const content =
      typeof todo['content'] === 'string' ? boundedText(todo['content'], TODO_TEXT_CAP) : '';
    const status = todo['status'];
    if (
      !id ||
      !content ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    ) {
      continue;
    }
    const activeForm =
      typeof todo['activeForm'] === 'string'
        ? boundedText(todo['activeForm'], TODO_TEXT_CAP)
        : undefined;
    todos.push({ id, content, status, ...(activeForm ? { activeForm } : {}) });
    if (todos.length >= TODO_LIMIT) break;
  }
  return todos;
}

function compactToolInput(input: unknown): {
  input?: unknown | undefined;
  inputLines?: number | undefined;
  oldLines?: number | undefined;
  newLines?: number | undefined;
  addedLines?: number | undefined;
  removedLines?: number | undefined;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return typeof input === 'string' ? { input: compactText(input) } : {};
  }
  const source = input as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  const safeKeys = [
    'file_path',
    'filePath',
    'path',
    'filename',
    'target_file',
    'targetFile',
    'line',
    'start_line',
    'startLine',
    'end_line',
    'endLine',
    'offset',
    'limit',
    'command',
    'cmd',
    'url',
    'href',
    'uri',
    'query',
    'pattern',
  ];
  for (const key of safeKeys) {
    const value = source[key];
    if (typeof value === 'string') safe[key] = compactText(value);
    else if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  }

  const content = [source['content'], source['text'], source['data']].find(
    (value): value is string => typeof value === 'string',
  );
  const oldText = [source['old_string'], source['oldString'], source['search']].find(
    (value): value is string => typeof value === 'string',
  );
  const newText = [source['new_string'], source['newString'], source['replacement']].find(
    (value): value is string => typeof value === 'string',
  );
  const patch = [source['patch'], source['diff']].find(
    (value): value is string => typeof value === 'string',
  );
  const delta = patch ? patchDelta(patch) : undefined;

  return {
    ...(Object.keys(safe).length > 0 ? { input: safe } : {}),
    ...(content !== undefined ? { inputLines: lineCount(content) } : {}),
    ...(oldText !== undefined ? { oldLines: lineCount(oldText) } : {}),
    ...(newText !== undefined ? { newLines: lineCount(newText) } : {}),
    ...(delta && delta.addedLines > 0 ? { addedLines: delta.addedLines } : {}),
    ...(delta && delta.removedLines > 0 ? { removedLines: delta.removedLines } : {}),
  };
}

export function completedToolReceipt(
  payload: CompletedToolPayload,
  pending?: PendingTool,
): AgentRecentTool {
  const completedAt = Date.now();
  const durationMs = Math.max(
    0,
    payload.durationMs ?? completedAt - (pending?.startedAt ?? completedAt),
  );
  const compact = compactToolInput(payload.input ?? pending?.input);
  return {
    id: payload.id ?? `${payload.name}:${completedAt}`,
    name: payload.name,
    startedAt: pending?.startedAt ?? Math.max(0, completedAt - durationMs),
    completedAt,
    durationMs,
    ok: payload.ok !== false,
    ...compact,
    ...(payload.output !== undefined ? { output: compactText(payload.output) } : {}),
    ...(payload.outputLines !== undefined ? { outputLines: payload.outputLines } : {}),
    ...(payload.outputBytes !== undefined ? { outputBytes: payload.outputBytes } : {}),
    ...(payload.outputTokens !== undefined ? { outputTokens: payload.outputTokens } : {}),
  };
}

export function emptyActivityTotals(): AgentActivityTotals {
  return {
    filesTouched: [],
    reads: 0,
    writes: 0,
    edits: 0,
    terminalCalls: 0,
    webCalls: 0,
    searches: 0,
    otherCalls: 0,
    mailReceived: 0,
    mailSent: 0,
    linesRead: 0,
    linesWritten: 0,
    linesAdded: 0,
    linesRemoved: 0,
  };
}

export function addMailTotal(
  current: AgentActivityTotals | undefined,
  direction: AgentRecentMail['direction'],
): AgentActivityTotals {
  const next = { ...(current ?? emptyActivityTotals()) };
  if (direction === 'incoming') next.mailReceived += 1;
  else next.mailSent += 1;
  return next;
}

function toolActivityKind(
  name: string,
): 'read' | 'write' | 'edit' | 'terminal' | 'web' | 'search' | 'other' {
  const normalized = name.toLowerCase().replace(/[.:/-]+/g, '_');
  if (/^(read|view|open_file|read_file)|file_read/.test(normalized)) return 'read';
  if (/^(write|create|save)|file_write/.test(normalized)) return 'write';
  if (/edit|update|patch|replace|apply_patch/.test(normalized)) return 'edit';
  if (/bash|shell|terminal|exec|command|powershell|cmd/.test(normalized)) return 'terminal';
  if (/fetch|browser|browse|http|url|web/.test(normalized)) return 'web';
  if (/search|grep|find|glob|query/.test(normalized)) return 'search';
  return 'other';
}

function receiptFilePath(receipt: AgentRecentTool): string | undefined {
  if (!receipt.input || typeof receipt.input !== 'object' || Array.isArray(receipt.input)) {
    return undefined;
  }
  const input = receipt.input as Record<string, unknown>;
  for (const key of ['file_path', 'filePath', 'path', 'filename', 'target_file', 'targetFile']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function addToolActivity(
  current: AgentActivityTotals | undefined,
  receipt: AgentRecentTool,
): AgentActivityTotals {
  const next: AgentActivityTotals = {
    ...(current ?? emptyActivityTotals()),
    filesTouched: [...(current?.filesTouched ?? [])],
  };
  const kind = toolActivityKind(receipt.name);
  if (kind === 'read') {
    next.reads += 1;
    next.linesRead += receipt.outputLines ?? 0;
  } else if (kind === 'write') {
    next.writes += 1;
    next.linesWritten += receipt.inputLines ?? 0;
  } else if (kind === 'edit') {
    next.edits += 1;
    next.linesAdded += receipt.addedLines ?? receipt.newLines ?? 0;
    next.linesRemoved += receipt.removedLines ?? receipt.oldLines ?? 0;
  } else if (kind === 'terminal') next.terminalCalls += 1;
  else if (kind === 'web') next.webCalls += 1;
  else if (kind === 'search') next.searches += 1;
  else next.otherCalls += 1;

  const filePath = receiptFilePath(receipt);
  if (
    filePath &&
    !next.filesTouched.includes(filePath) &&
    next.filesTouched.length < TOUCHED_FILE_LIMIT
  ) {
    next.filesTouched.push(filePath);
  }
  return next;
}

export function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}
