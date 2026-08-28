import type {
  ContentBlock,
  Renderer,
  TextBlock,
  ToolResultRenderMode,
} from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { renderDiff } from './diff-renderer.js';
import { theme } from './theme.js';

interface TerminalRendererOptions {
  out?: NodeJS.WriteStream | undefined;
  err?: NodeJS.WriteStream | undefined;
}

export class TerminalRenderer implements Renderer {
  private readonly out: NodeJS.WriteStream;
  private readonly err: NodeJS.WriteStream;
  private lineStart = true;
  /** When true, stdout-bound rendering is disabled (for non-terminal UI surfaces). */
  private silent = false;
  /**
   * When true, Ink exclusively owns the terminal. Both stdout and stderr
   * rendering must be disabled: either stream can interleave with Ink's
   * cursor updates and make the TUI flicker or leave stray debug notes.
   */
  private tuiActive = false;
  /**
   * Per-tool on-screen result render mode. Defaults to `'extend'` so
   * existing callers without `setResultRenderMode` see full content.
   * `setResultRenderMode(name, mode)` overrides the entry for `name`; the
   * override is one-shot for that name (the default reasserts after the
   * next write) so callers can set the mode right before each tool call
   * without leaking state across unrelated tool calls.
   */
  private renderModes = new Map<string, ToolResultRenderMode>();
  /** Mode applied when no entry is set for a given tool name. */
  private static readonly DEFAULT_RENDER_MODE: ToolResultRenderMode = 'extend';
  /** Maximum number of one-shot hints retained when callers abandon a result. */
  private static readonly MAX_RENDER_MODES = 256;
  /** Lines kept per tool family in `extend` mode. */
  private static readonly EXTEND_PREVIEW_LINES = 10;

  constructor(opts: TerminalRendererOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.err = opts.err ?? process.stderr;
  }

  /**
   * Toggle stdout suppression for non-terminal UI surfaces such as WebUI.
   * Diagnostics continue to flow to stderr. Idempotent.
   */
  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  isSilent(): boolean {
    return this.silent;
  }

  /**
   * Toggle exclusive TUI ownership of both terminal streams. Unlike
   * {@link setSilent}, TUI mode suppresses stderr as well as stdout and clears
   * any CLI-only result mode staged before Ink took ownership. While active,
   * new result-mode hints are ignored. The two flags compose with OR semantics
   * for stdout suppression only; TUI ownership adds the other behaviors.
   * Enable immediately before starting Ink and disable in the paired
   * `finally`, only after the TUI has fully exited.
   */
  setTuiActive(active: boolean): void {
    // Drop any CLI-only hint staged before Ink took ownership. While active,
    // setResultRenderMode is suppressed and matching result writes consume
    // defensively, so no one-shot mode can survive the TUI boundary.
    if (active) this.renderModes.clear();
    this.tuiActive = active;
  }

  isTuiActive(): boolean {
    return this.tuiActive;
  }

  private suppressStdout(): boolean {
    return this.silent || this.tuiActive;
  }

  setResultRenderMode(name: string, mode: ToolResultRenderMode): void {
    if (this.suppressStdout()) return;
    // Refreshing an existing hint must not evict an unrelated one.
    if (this.renderModes.delete(name)) {
      this.renderModes.set(name, mode);
      return;
    }
    if (this.renderModes.size >= TerminalRenderer.MAX_RENDER_MODES) {
      const oldestName = this.renderModes.keys().next().value;
      if (oldestName !== undefined) this.renderModes.delete(oldestName);
    }
    this.renderModes.set(name, mode);
  }

  private getRenderMode(name: string): ToolResultRenderMode {
    return this.renderModes.get(name) ?? TerminalRenderer.DEFAULT_RENDER_MODE;
  }

  private clearRenderMode(name: string): void {
    this.renderModes.delete(name);
  }

  write(input: string | TextBlock): void {
    if (this.suppressStdout()) return;
    const text = typeof input === 'string' ? input : input.text;
    if (!text) return;
    const rendered = renderMarkdown(text);
    this.out.write(rendered);
    this.lineStart = rendered.endsWith('\n');
  }

  writeLine(text = ''): void {
    if (this.suppressStdout()) return;
    if (!this.lineStart) this.out.write('\n');
    if (text) this.out.write(`${text}\n`);
    else this.out.write('\n');
    this.lineStart = true;
  }

  writeBlock(block: ContentBlock): void {
    if (block.type === 'tool_result') {
      const text =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      this.writeToolResult(block.name ?? 'result', text, !!block.is_error);
      return;
    }
    if (this.suppressStdout()) return;
    if (block.type === 'text') {
      this.write(block);
    } else if (block.type === 'tool_use') {
      this.writeToolCall(block.name, block.input);
    }
  }

  writeToolCall(name: string, input: unknown): void {
    if (this.suppressStdout()) return;
    if (!this.lineStart) this.out.write('\n');
    const arrow = theme.primary('→');
    const display = formatInputSummary(input);
    this.out.write(`${arrow} ${theme.bold(name)}${display ? color.dim(` ${display}`) : ''}\n`);
    this.lineStart = true;
  }

  writeToolResult(name: string, content: unknown, isError: boolean): void {
    if (this.suppressStdout()) {
      // TUI/WebUI rendering happens elsewhere, but this call still represents
      // the one result that consumes a staged per-tool mode. Dropping the write
      // without clearing would leak the override into the next CLI result.
      this.clearRenderMode(name);
      return;
    }
    const txt = typeof content === 'string' ? content : safeStringify(content);
    const prefix = isError ? theme.error('✘') : theme.success('✓');
    const renderMode = this.getRenderMode(name);
    // One-shot mode: consume the override so an unset call doesn't carry
    // the previous tool's mode into the next one.
    this.clearRenderMode(name);

    // Tools that embed user-visible text in a `text` field (read, etc.)
    // arrive here as a JSON-string like `{"path":"…","text":"line-1\nline-2"}`.
    // For the extend-mode preview we want to slice the *body* lines, not the
    // serialised JSON. `summarize` already parses the structured value;
    // pull `text` out here when present so the preview head/tail match
    // what the user actually saw.
    const bodyText = extractBodyText(content, name);

    if (isError) {
      const firstLine = txt.split('\n')[0] ?? '';
      const truncated = firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine;
      this.out.write(`  ${prefix} ${color.dim(truncated)}\n`);
      this.lineStart = true;
      return;
    }

    // Edit-like tools: pull the embedded diff if present.
    const isEditLike = name === 'edit' || name === 'write';
    const diff = extractDiff(content);
    if (isEditLike && diff) {
      this.out.write(`  ${prefix} ${color.dim(summarize(content, name))}\n`);
      const rendered = renderDiff(diff)
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n');
      this.out.write(`${rendered}\n`);
      this.lineStart = true;
      return;
    }

    const summary = summarize(content, name);
    const isReadLike =
      name === 'read' || name === 'grep' || name === 'glob' || name === 'bash' || name === 'exec';

    // SIMPLE mode: meta only — no content lines. For tools whose result
    // already carries structured metadata (read/grep/glob/bash), the
    // summary line is the entire on-screen rendering. For unknown tools,
    // show the first line as a tiny preview to avoid hiding failure modes
    // that aren't summarised.
    if (renderMode === 'simple') {
      this.out.write(`  ${prefix} ${color.dim(summary || compactSingleLine(bodyText))}\n`);
      this.lineStart = true;
      return;
    }

    // EXTEND mode: full preview, up to 10 lines for read-like tools.
    const previewLines = isEditLike ? 0 : isReadLike ? TerminalRenderer.EXTEND_PREVIEW_LINES : 2;

    const lines = bodyText.split('\n');
    const head = lines.slice(0, previewLines).map((l: string) => l.replace(/\s+$/, ''));
    const moreCount = Math.max(0, lines.length - head.length);
    this.out.write(`  ${prefix} ${color.dim(summary)}\n`);
    for (const l of head) {
      const capped = l.length > 200 ? `${l.slice(0, 197)}…` : l;
      this.out.write(`      ${color.dim(capped)}\n`);
    }
    if (moreCount > 0) {
      this.out.write(
        `      ${color.dim(`+${moreCount} more line${moreCount === 1 ? '' : 's'}`)}\n`,
      );
    }
    this.lineStart = true;
  }

  writeDiff(diff: string): void {
    if (this.suppressStdout()) return;
    if (!this.lineStart) this.out.write('\n');
    this.out.write(`${renderDiff(diff)}\n`);
    this.lineStart = true;
  }

  writeWarning(text: string): void {
    if (this.tuiActive) return;
    this.err.write(`${theme.warn('⚠')} ${text}\n`);
  }
  writeError(text: string): void {
    if (this.tuiActive) return;
    this.err.write(`${theme.error('✘')} ${text}\n`);
  }
  writeInfo(text: string): void {
    if (this.tuiActive) return;
    this.err.write(`${theme.info('ℹ')} ${text}\n`);
  }

  /**
   * Write text to stderr verbatim: no glyph prefix, no markdown processing.
   *
   * Deliberately stricter than writeWarning/writeError/writeInfo, which emit
   * *diagnostics* and are suppressed only when a TUI owns the terminal (so
   * they survive silent mode). This method is for informational mirrors of
   * stdout output, where the stdout copy already carries the full content —
   * in silent mode the operator asked for machine-only output, so the mirror
   * is dropped rather than leaked onto a quieter stream. It therefore honors
   * the full {@link suppressStdout} gate.
   *
   * Used by `wstack mailbox serve` to route the human-readable startup banner
   * away from stdout, keeping the mailbox_serve_started JSON line cleanly
   * pipeable (`mailbox serve | jq`).
   */
  writeStderr(text: string): void {
    if (this.suppressStdout()) return;
    this.err.write(text);
  }

  clear(): void {
    if (this.suppressStdout()) return;
    this.out.write('\x1b[2J\x1b[H');
    this.lineStart = true;
  }

  /**
   * Write a flashy agent completion banner for delegate tool results.
   * Renders a box like:
   * ┌─────────────────────────────────────┐
   * │  ✓ [role] done in 4m 32s           │
   * │    127 iterations · 341 tools        │
   * │    Found 14 bugs across 6 files...   │
   * └─────────────────────────────────────┘
   */
  writeAgentSummary(summary: string, ok: boolean): void {
    if (this.suppressStdout()) return;
    if (!this.lineStart) this.out.write('\n');

    const lines = summary.split('\n');
    const icon = ok ? theme.success('✓') : theme.error('✘');
    const firstLine = `${icon} ${lines[0] ?? summary}`;
    const body = lines.slice(1);

    // Compute width: min 44, max terminal width (fallback 80).
    const maxWidth = Math.min(process.stdout.columns ?? 80, 120);
    const contentWidth = Math.max(
      firstLine.length,
      body.reduce((a, l) => Math.max(a, l.length), 0),
    );
    const boxWidth = Math.min(Math.max(contentWidth + 4, 44), maxWidth);

    const thick = '━'.repeat(boxWidth - 2);
    const thin = '─'.repeat(boxWidth - 2);

    this.out.write(`\n ${theme.primary('┌')}${thick}${theme.primary('┐')}\n`);

    const centre = (s: string) => {
      const inner = ` ${s} `;
      const padLen = Math.max(0, boxWidth - 2 - s.length);
      const left = Math.floor(padLen / 2);
      const right = padLen - left;
      return `${' '.repeat(left)}${inner}${' '.repeat(right)}`;
    };

    this.out.write(` ${theme.primary('│')}${centre(firstLine)}${theme.primary('│')}\n`);

    for (const l of body) {
      this.out.write(
        ` ${theme.primary('│')} ${l}${' '.repeat(Math.max(0, boxWidth - 3 - l.length))}${theme.primary('│')}\n`,
      );
    }

    this.out.write(` ${theme.primary('└')}${thin}${theme.primary('┘')}\n`);
    this.lineStart = true;
  }

  /**
   * Render subagent completion banners from a RunResult.
   * Uses `delegateSummaries` when available (populated by delegate tool),
   * otherwise falls back to scanning message history.
   */
  writeDelegateSummaries(result: {
    delegateSummaries?: Array<{ summary: string | undefined; ok: boolean }>;
    messages?: Array<unknown> | undefined;
  }): void {
    if (this.suppressStdout()) return;
    // Prefer the structured field from delegate tool.
    if (result.delegateSummaries) {
      for (const { summary, ok } of result.delegateSummaries) {
        if (!summary) continue;
        this.writeAgentSummary(summary, ok);
      }
      return;
    }
    // Fallback: scan message history for delegate tool_result blocks.
    if (!result.messages) return;
    for (const msg of result.messages) {
      const m = msg as { content?: Array<unknown> | undefined };
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        const b = block as {
          type?: string | undefined;
          name?: string | undefined;
          content?: unknown | undefined;
        };
        if (b.type !== 'tool_result' || b.name !== 'delegate') continue;
        let obj: unknown;
        try {
          obj = typeof b.content === 'string' ? JSON.parse(b.content) : b.content;
        } catch {
          continue;
        }
        const o = obj as { summary?: string | undefined; ok?: boolean | undefined };
        if (o.summary) {
          this.writeAgentSummary(o.summary, o.ok ?? true);
        }
      }
    }
  }
}

function renderMarkdown(s: string): string {
  let out = s;
  // Headings
  out = out.replace(/^(#{1,6}) (.+)$/gm, (_m, hashes, text) => {
    return theme.primary(theme.bold(`${hashes} ${text}`));
  });
  // Fenced code
  out = out.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return color.gray(`\n┌─\n${code.replace(/^/gm, '│ ')}└─`);
  });
  // Inline code
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => theme.accent(code));
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, text) => theme.bold(text));
  // Italic — single-asterisk
  out = out.replace(
    /(^|[^*])\*([^*\n]+)\*([^*]|$)/g,
    (_m, l, t, r) => `${l}${color.italic(t)}${r}`,
  );
  return out;
}

function formatInputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (typeof obj['path'] === 'string') return obj['path'] as string;
  if (typeof obj['url'] === 'string') return obj['url'] as string;
  if (typeof obj['command'] === 'string') {
    const cmd = obj['command'] as string;
    return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  }
  if (typeof obj['pattern'] === 'string') return obj['pattern'] as string;
  return '';
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Pull the user-visible body text out of a structured tool result so the
 * extend-mode preview slices real lines, not serialised JSON.
 *
 * - `read` returns `{text, total_lines, ...}` — the body is `text`.
 * - `bash` returns `{output, exit_code, ...}` (stdout+stderr merged) — the
 *   body is `output` (plus `error` when present).
 * - `exec` returns `{stdout, stderr, exitCode, ...}` — the body is the
 *   joined stdout/stderr string so multi-line output is previewable.
 * - Plain strings and structured payloads without a body field fall back
 *   to the serialised form (existing behaviour).
 */
function extractBodyText(value: unknown, name: string): string {
  let v: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        v = JSON.parse(value);
      } catch {
        return value;
      }
    } else {
      return value;
    }
  }
  if (typeof v !== 'object' || v === null) {
    return safeStringify(value);
  }
  const o = v as Record<string, unknown>;
  if (name === 'read' && typeof o['text'] === 'string') return o['text'] as string;
  if (name === 'bash') {
    // bash merges stdout+stderr into a single `output` string (there are no
    // stdout/stderr fields on its result — reading those rendered nothing).
    const output = typeof o['output'] === 'string' ? (o['output'] as string) : '';
    const error = typeof o['error'] === 'string' ? (o['error'] as string) : '';
    if (output && error) return `${output}\n${error}`;
    return output || error || '';
  }
  if (name === 'exec') {
    const stdout = typeof o['stdout'] === 'string' ? (o['stdout'] as string) : '';
    const stderr = typeof o['stderr'] === 'string' ? (o['stderr'] as string) : '';
    if (stdout && stderr) return `${stdout}\n${stderr}`;
    return stdout || stderr || '';
  }
  // No body field recognised — return the serialised form so the preview
  // still shows something rather than going blank.
  return safeStringify(value);
}

/**
 * If the tool result is an object with a `diff` field (e.g. from the edit
 * tool), return that. If it's a string containing a unified diff header,
 * return it as-is. Otherwise return null and the caller falls back to a
 * generic preview.
 */
function extractDiff(value: unknown): string | null {
  if (typeof value === 'object' && value !== null) {
    const d = (value as { diff?: unknown | undefined }).diff;
    if (typeof d === 'string' && d.length > 0) return d;
  }
  if (typeof value === 'string') {
    // The agent serialises tool results to JSON before handing them to the
    // renderer, so a string `{"diff": "..."}` is the common case. Try parsing.
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(value) as { diff?: unknown | undefined };
        if (typeof parsed.diff === 'string' && parsed.diff.length > 0) {
          return parsed.diff;
        }
      } catch {
        // fall through
      }
    }
    if (/^---[^\n]*\n\+\+\+/m.test(value)) return value;
  }
  return null;
}

/**
 * Short summary shown next to the ✓: file path + count for edit, line count
 * for read/grep, etc. Falls back to nothing if the shape isn't recognised.
 *
 * For `read`, returns `path  N lines (truncated|cached)`. For `bash`,
 * returns `exit=N  X lines / Y bytes`. For tools without structured meta,
 * returns an empty string and the renderer falls back to a single-line
 * preview so unknown shapes still get some on-screen signal.
 */
function summarize(value: unknown, name: string): string {
  // Tool results arrive at the renderer already serialised to a JSON string.
  // Re-parse so we can pull out structured fields. Falls back to the raw value
  // for tools that return plain strings.
  let v: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        v = JSON.parse(value);
      } catch {
        // not JSON — leave as string
      }
    }
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (name === 'edit') {
      const path = typeof o['path'] === 'string' ? (o['path'] as string) : '';
      const reps = typeof o['replacements'] === 'number' ? (o['replacements'] as number) : 0;
      return `${path}  ${reps} replacement${reps === 1 ? '' : 's'}`.trim();
    }
    if (name === 'write') {
      const path = typeof o['path'] === 'string' ? (o['path'] as string) : '';
      const bytes = typeof o['bytes'] === 'number' ? (o['bytes'] as number) : undefined;
      return bytes !== undefined ? `${path}  ${bytes}B` : path;
    }
    if (name === 'read') {
      return summarizeRead(o);
    }
    if (name === 'bash') {
      return summarizeBash(o);
    }
    if (name === 'exec') {
      return summarizeExec(o);
    }
    if (typeof o['count'] === 'number') {
      return `${o['count']} match${o['count'] === 1 ? '' : 'es'}`;
    }
  }
  return '';
}

function summarizeRead(o: Record<string, unknown>): string {
  const path = typeof o['path'] === 'string' ? (o['path'] as string) : '';
  const total = typeof o['total_lines'] === 'number' ? (o['total_lines'] as number) : undefined;
  const truncated = o['truncated'] === true;
  const cached = o['cached'] === true;
  const note = typeof o['note'] === 'string' ? (o['note'] as string) : undefined;
  const parts: string[] = [];
  if (path) parts.push(path);
  if (total !== undefined) parts.push(`${total} line${total === 1 ? '' : 's'}`);
  const flags: string[] = [];
  if (truncated) flags.push('truncated');
  if (cached) flags.push('cached');
  if (flags.length > 0) parts.push(`(${flags.join(', ')})`);
  let summary = parts.join('  ').trim();
  if (note) summary = summary ? `${summary} — ${note}` : note;
  return summary;
}

function summarizeBash(o: Record<string, unknown>): string {
  // bash results carry `output` (stdout+stderr merged) and `exit_code` —
  // NOT stdout/stderr/exitCode. The old field names silently produced an
  // empty summary for every bash result.
  const exit = typeof o['exit_code'] === 'number' ? (o['exit_code'] as number) : undefined;
  const output = typeof o['output'] === 'string' ? (o['output'] as string) : '';
  const lines = output ? output.split('\n').length : 0;
  const parts: string[] = [];
  if (exit !== undefined) parts.push(`exit=${exit}`);
  else if (o['exit_code'] === null) parts.push('backgrounded');
  if (o['timed_out'] === true) parts.push('timed out');
  if (lines > 0) parts.push(`${lines} output line${lines === 1 ? '' : 's'}`);
  if (output.length > 0) parts.push(`${output.length}B`);
  return parts.join('  ');
}

function summarizeExec(o: Record<string, unknown>): string {
  const command = typeof o['command'] === 'string' ? (o['command'] as string) : '';
  const args = Array.isArray(o['args'])
    ? (o['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  const exit = typeof o['exitCode'] === 'number' ? (o['exitCode'] as number) : undefined;
  const stdout = typeof o['stdout'] === 'string' ? (o['stdout'] as string) : '';
  const stderr = typeof o['stderr'] === 'string' ? (o['stderr'] as string) : '';
  const outLines = stdout ? stdout.split('\n').length : 0;
  const errLines = stderr ? stderr.split('\n').length : 0;
  const totalBytes = stdout.length + stderr.length;
  const parts: string[] = [];
  const invocation = [command, ...args].filter(Boolean).join(' ');
  if (invocation) parts.push(`$ ${invocation}`);
  if (exit !== undefined) parts.push(`exit=${exit}`);
  if (outLines > 0) parts.push(`${outLines} stdout line${outLines === 1 ? '' : 's'}`);
  if (errLines > 0) parts.push(`${errLines} stderr line${errLines === 1 ? '' : 's'}`);
  if (totalBytes > 0) parts.push(`${totalBytes}B`);
  return parts.join('  ');
}

/**
 * Last-resort single-line preview used when `summarize` returns nothing
 * (e.g. unknown tool result shape). Trims whitespace, takes the first
 * line, and caps at 200 chars to match the per-line cap in extend mode.
 */
function compactSingleLine(text: string): string {
  const first = text.split('\n')[0]?.trim() ?? '';
  if (!first) return '(no output)';
  return first.length > 200 ? `${first.slice(0, 197)}…` : first;
}
