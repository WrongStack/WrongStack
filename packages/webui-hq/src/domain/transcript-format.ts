/**
 * Transcript formatting helpers for the HQ Live Console.
 *
 * Pure functions — no React, no DOM. The heavy lifting (tool-input summaries,
 * diff extraction) is delegated to the shared browser-safe
 * `@wrongstack/tools` subpaths so the HQ Console, the main WebUI and the TUI
 * all render tool calls from the same single source of truth. What remains
 * here is HQ-specific: transcript-entry classification, todo extraction from
 * stringified input, and small display formatters.
 *
 * @module lib/transcript-format
 */
import { summarizeToolInput as sharedSummarize } from '@wrongstack/tools/tool-summary';

/** Broad tool family used to pick a result renderer. */
export type ToolKind = 'edit' | 'write' | 'bash' | 'read' | 'search' | 'fetch' | 'todo' | 'generic';

/** Classify a tool by name into a rendering family. Case-insensitive. */
export function classifyTool(toolName: string | undefined): ToolKind {
  const n = (toolName ?? '').toLowerCase().replace(/^mcp__[^_]+__/, '');
  if (/^(edit|str_replace|edit_file|patch|apply_patch|multiedit)$/.test(n)) return 'edit';
  if (/^(write|write_file|create_file|new_file)$/.test(n)) return 'write';
  if (/^(bash|shell|exec|run|run_command|run_shell|powershell|terminal)$/.test(n)) return 'bash';
  if (/^(read|read_file|cat|open)$/.test(n)) return 'read';
  if (/^(grep|search|ripgrep|glob|find)$/.test(n)) return 'search';
  if (/^(fetch|http|web|webfetch|websearch|curl|request)$/.test(n)) return 'fetch';
  if (/todo/.test(n)) return 'todo';
  return 'generic';
}

/** Parse a string that MIGHT be JSON; returns the value or `undefined`. */
export function tryParseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === '' || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * One-line, tool-aware summary of a tool's input — the collapsed-card
 * subtitle. Delegates to the shared `@wrongstack/tools/tool-summary`
 * implementation (which accepts HQ's stringified-JSON input directly).
 */
export function summarizeToolInput(
  toolName: string | undefined,
  input: string | undefined,
): string {
  if (input === undefined || input === '' || input === '{}') return '';
  return sharedSummarize(toolName, input);
}

/** A pretty, human-readable rendering of a tool's stringified JSON input. */
export function prettyInput(input: string | undefined): string {
  const parsed = tryParseJson(input);
  if (parsed === undefined) return input ?? '';
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return input ?? '';
  }
}

export type TodoStatus = 'completed' | 'in_progress' | 'pending';
export interface TodoItem {
  status: TodoStatus;
  content: string;
}

/**
 * Extract the todo list from a TodoWrite tool's stringified input, normalized to
 * `{status, content}`. Returns `null` when the input isn't a todo write.
 */
export function extractTodos(input: string | undefined): TodoItem[] | null {
  const parsed = tryParseJson(input);
  if (parsed === null || typeof parsed !== 'object') return null;
  const raw = (parsed as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;
  const todos: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const status: TodoStatus =
      o.status === 'completed'
        ? 'completed'
        : o.status === 'in_progress'
          ? 'in_progress'
          : 'pending';
    const content =
      typeof o.content === 'string'
        ? o.content
        : typeof o.subject === 'string'
          ? o.subject
          : typeof o.title === 'string'
            ? o.title
            : '';
    todos.push({ status, content });
  }
  return todos.length > 0 ? todos : null;
}

/** Human-friendly duration for a tool call (e.g. `820ms`, `2.4s`, `1m3s`). */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  // Math.round(59.5) === 60: a duration in the last 500 ms of a minute must
  // roll into the next minute instead of rendering "1m60s".
  if (s === 60) return `${m + 1}m0s`;
  return `${m}m${s}s`;
}

/** Short display label for a tool name, stripping the `mcp__server__` prefix. */
export function toolDisplayName(toolName: string | undefined): string {
  if (!toolName) return 'tool';
  return toolName.replace(/^mcp__([^_]+)__/, '$1:');
}

/** Format a timestamp string as a local `HH:MM:SS`, or '' when unparseable. */
export function formatClock(ts: string | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
