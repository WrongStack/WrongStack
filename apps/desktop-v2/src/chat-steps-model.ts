import type { ActivityRow } from './session-activity-model';
import { toolInputView } from './tool-input-view';

/** The past-tense (or running) verb a conversation step leads with; `null` keeps the tool name. */
export type StepVerb =
  | 'searched'
  | 'read'
  | 'edited'
  | 'wrote'
  | 'ran'
  | 'running'
  | 'fetched'
  | 'listed'
  | 'delegated'
  | 'updatedPlan'
  | null;

export interface PlanItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type ChatStep =
  | { kind: 'thought'; row: ActivityRow; durationMs?: number }
  | { kind: 'plan'; row: ActivityRow; items: PlanItem[] }
  | { kind: 'command'; row: ActivityRow; command: string }
  | {
      kind: 'tool';
      row: ActivityRow;
      verb: StepVerb;
      target: string;
      added?: number;
      removed?: number;
      /** The file an edit or write changed, whole (the target may be shortened). */
      path?: string;
      /** The edit's lines, when the edit is small enough to show under its row. */
      diff?: { removed: string[]; added: string[] };
    }
  | { kind: 'note'; row: ActivityRow };

/** A call quicker than this shows no time: "0.0 s" on every fast read said nothing. */
export const MEASURABLE_MS = 100;

/** Edits up to this many changed lines show their diff under the row in a live turn. */
export const INLINE_DIFF_LINES = 14;
const TARGET_LIMIT = 120;
const TAIL_SCAN_CHARS = 16_384;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const oneLine = (value: string) => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > TARGET_LIMIT ? `${line.slice(0, TARGET_LIMIT - 1)}…` : line;
};

function verbFor(name: string, running: boolean): StepVerb {
  const key = name.toLowerCase();
  if (/^(grep|glob|search|find|codebase_search|symbol_search)/.test(key)) return 'searched';
  if (key === 'read' || key === 'read_file' || key === 'view') return 'read';
  if (/^(edit|multi_edit|str_replace|replace|patch|apply_patch)$/.test(key)) return 'edited';
  if (key === 'write' || key === 'write_file' || key === 'create_file') return 'wrote';
  if (/^(bash|exec|shell|powershell|terminal)$/.test(key)) return running ? 'running' : 'ran';
  if (/^(fetch|web_fetch|http|http_request|web_search)$/.test(key)) return 'fetched';
  if (key === 'ls' || key === 'list_dir' || key === 'list_files') return 'listed';
  if (/^(task|delegate|spawn_agent|agent)$/.test(key)) return 'delegated';
  return null;
}

/** The todo tool's list as the call wrote it; empty when the input is not a todo list. */
function todoItems(input: unknown): PlanItem[] {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo, index) => {
    const item = todo as Record<string, unknown> | null;
    const content = text(item?.['content']).trim();
    if (!content) return [];
    const status = item?.['status'];
    return [
      {
        id: text(item?.['id']) || String(index),
        content,
        status:
          status === 'completed' || status === 'in_progress'
            ? status
            : ('pending' as PlanItem['status']),
      },
    ];
  });
}

/**
 * The conversation's view of a turn's activity: one line per tool call led by what it did
 * ("Searched", "Read", "Edited"), the turn's latest plan as a card, a running command with its
 * output, and reasoning as a quiet line. Iteration boundaries and a completed run's result are
 * dropped (the full run log keeps them); failures, stops and retries stay as notes.
 */
export function chatSteps(rows: readonly ActivityRow[], showThinking: boolean): ChatStep[] {
  const lastPlan = rows.findLastIndex(
    (row) => row.kind === 'tool' && row.title === 'todo' && todoItems(row.input).length > 0,
  );
  const steps: ChatStep[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'reasoning') {
      if (!showThinking) return;
      // Measured only when both ends carry a frame time: the reasoning's first frame and the
      // next row's start. Streams without frame times say "Thought" with no number.
      const next = rows[index + 1];
      const durationMs =
        row.at !== undefined && next?.at !== undefined && next.at >= row.at
          ? next.at - row.at
          : undefined;
      steps.push(
        durationMs === undefined ? { kind: 'thought', row } : { kind: 'thought', row, durationMs },
      );
      return;
    }
    if (row.kind === 'run') {
      const iteration = row.iterationId === row.id;
      if (iteration || row.status === 'done') return;
      steps.push({ kind: 'note', row });
      return;
    }
    if (row.kind === 'retry') {
      steps.push({ kind: 'note', row });
      return;
    }
    if (row.title === 'todo' && index === lastPlan) {
      steps.push({ kind: 'plan', row, items: todoItems(row.input) });
      return;
    }
    const view = toolInputView(row.title, row.input);
    if (view.kind === 'command' && row.status === 'running') {
      steps.push({ kind: 'command', row, command: oneLine(view.command) });
      return;
    }
    const verb =
      row.title === 'todo' ? 'updatedPlan' : verbFor(row.title, row.status === 'running');
    const value = (row.input ?? {}) as Record<string, unknown>;
    const target =
      view.kind === 'edit' || view.kind === 'write'
        ? view.path
        : view.kind === 'read'
          ? view.range === 'whole file'
            ? view.path
            : `${view.path} · ${view.range}`
          : view.kind === 'command'
            ? oneLine(view.command)
            : view.kind === 'search'
              ? `"${view.pattern}"${view.path ? ` in ${view.path}` : ''}`
              : view.kind === 'replace'
                ? view.pattern
                : view.kind === 'design_reference'
                  ? view.target
                  : row.title === 'todo'
                    ? ''
                    : oneLine(
                        ['path', 'file', 'url', 'query', 'pattern', 'command', 'task', 'name']
                          .map((key) => text(value[key]))
                          .find(Boolean) ?? '',
                      );
    const step: Extract<ChatStep, { kind: 'tool' }> = {
      kind: 'tool',
      row,
      verb,
      target: oneLine(target),
    };
    if (view.kind === 'edit' || view.kind === 'write') step.path = view.path;
    if (view.kind === 'edit') {
      step.added = view.added.length;
      step.removed = view.removed.length;
      if (view.added.length + view.removed.length <= INLINE_DIFF_LINES)
        step.diff = { removed: view.removed, added: view.added };
    } else if (view.kind === 'write') step.added = view.lines.length + view.more;
    steps.push(step);
  });
  return steps;
}

/** Measured tool time of the steps, in ms; `undefined` when no call reported a duration. */
export function stepsDuration(rows: readonly ActivityRow[]): number | undefined {
  let total: number | undefined;
  for (const row of rows)
    if (row.kind === 'tool' && row.durationMs !== undefined) total = (total ?? 0) + row.durationMs;
  return total;
}

/** "0.6 s", "4.1 s", "12 s", "3 min 05 s". */
export function stepSeconds(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** The last lines of a running command's output, for the live terminal block. */
export function outputTail(chunks: readonly string[], lines = 40): string {
  // A chunk usually ends its own line; joining must not add an empty line between chunks.
  // A long build prints megabytes; only the newest chunks can reach the last lines.
  let start = chunks.length,
    size = 0;
  while (start > 0 && size < TAIL_SCAN_CHARS) size += chunks[--start]!.length;
  const all = chunks
    .slice(start)
    .map((chunk) => chunk.replace(/\r\n?/g, '\n').replace(/\n$/, ''))
    .join('\n')
    .slice(-TAIL_SCAN_CHARS)
    .split('\n');
  while (all.length && !all.at(-1)?.trim()) all.pop();
  return all.slice(-lines).join('\n');
}

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

/**
 * The files a finished turn's edits and writes changed, in first-change order, with the lines
 * each call added and removed. Only calls that succeeded count; a failed edit changed nothing.
 */
export function changedFiles(rows: readonly ActivityRow[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const step of chatSteps(rows, false)) {
    if (step.kind !== 'tool' || step.row.status !== 'done') continue;
    if (step.verb !== 'edited' && step.verb !== 'wrote') continue;
    const path = step.path ?? '';
    if (!path) continue;
    const file = files.get(path) ?? { path, added: 0, removed: 0 };
    file.added += step.added ?? 0;
    file.removed += step.removed ?? 0;
    files.set(path, file);
  }
  return [...files.values()];
}
