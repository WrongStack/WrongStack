import * as path from 'node:path';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type {
  ContextEvidenceState,
  ToolOutputMetadata,
} from '@wrongstack/contracts/types/context-evidence';

/** Only scan the last N lines for error patterns — errors surface at the bottom. */
const EXTRACT_ERROR_TAIL_LINES = 200;

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function extractFiles(
  ctx: AgentContext,
  toolName: string,
  input: unknown,
  content: string,
): string[] {
  const out = new Set<string>();
  for (const value of inputPathValues(input)) addPath(ctx, out, value);

  if (toolName === 'grep' || toolName === 'glob' || toolName === 'bash') {
    const re = /(?:(?:[A-Za-z]:)?[./\\]?[\w@.-]+(?:[\\/][\w@(). -]+)+\.[A-Za-z0-9]{1,12})/g;
    for (const match of content.matchAll(re)) addPath(ctx, out, match[0]);
  }

  return [...out].slice(0, 30);
}

function inputPathValues(input: unknown): string[] {
  const values: string[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key && /^(path|file|files|fromFile|toFile|dir|cwd)$/i.test(key)) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
  };
  visit(input);
  return values;
}

function addPath(ctx: AgentContext, out: Set<string>, raw: string): void {
  const clean = raw.trim().replace(/^["'`]+|["'`),;:]+$/g, '');
  if (!clean || clean.length > 260) return;
  let normalized = clean.replace(/\\/g, '/');
  try {
    const abs = path.isAbsolute(clean) ? path.resolve(clean) : null;
    if (abs) {
      const rel = path.relative(ctx.projectRoot, abs);
      if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
        normalized = rel.replace(/\\/g, '/');
      }
    }
  } catch {
    // Keep the best-effort normalized string.
  }
  if (normalized.length > 0) out.add(normalized);
}

export function extractSymbols(content: string, input: unknown): string[] {
  const out = new Set<string>();
  const patterns = [
    /\b(?:function|class|interface|type|enum|const|let|var|def|fn|struct)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of patterns) {
    for (const match of content.matchAll(re)) {
      if (match[1]) out.add(match[1]);
      if (out.size >= 30) break;
    }
  }

  const pattern =
    input && typeof input === 'object' ? (input as Record<string, unknown>)['pattern'] : undefined;
  if (typeof pattern === 'string' && /^[A-Za-z_$][\w$]*$/.test(pattern)) {
    out.add(pattern);
  }

  return [...out].slice(0, 30);
}

export function extractCommands(toolName: string, input: unknown): string[] {
  if (toolName !== 'bash' && toolName !== 'exec' && toolName !== 'shell') return [];
  if (!input || typeof input !== 'object') return [];
  const command = (input as Record<string, unknown>)['command'];
  if (typeof command !== 'string') return [];
  return [command.slice(0, 220)];
}

export function extractErrors(content: string): string[] {
  const allLines = content.split(/\r?\n/);
  // Only scan the last N lines — errors and stack traces surface at the
  // bottom of tool output. Scanning all lines means one regex test per line,
  // so a 2000-line file read costs 2000 regex evaluations for no gain since
  // the interesting errors are always at the tail.
  const lines =
    allLines.length > EXTRACT_ERROR_TAIL_LINES
      ? allLines.slice(-EXTRACT_ERROR_TAIL_LINES)
      : allLines;
  const errors: string[] = [];
  for (const line of lines) {
    if (
      !/\b(error|exception|failed|failure|fatal|panic|timeout|denied|enoent|eacces|eperm|typeerror|syntaxerror)\b/i.test(
        line,
      )
    )
      continue;
    errors.push(normalizeWhitespace(line).slice(0, 260));
    if (errors.length >= 5) break;
  }
  return errors;
}

export function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['path', 'file', 'pattern', 'glob', 'command']) {
    const value = obj[key];
    if (typeof value === 'string') parts.push(`${key}=${value.slice(0, 160)}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function summarizeToolOutput(
  toolName: string,
  input: unknown,
  content: string,
  opts: { files: string[]; symbols: string[]; errors: string[]; ok: boolean },
): string {
  if (!opts.ok && opts.errors.length > 0) return opts.errors[0] ?? `${toolName} failed`;
  if (toolName === 'read' && opts.files[0]) return `read ${opts.files[0]}`;
  if (toolName === 'grep') {
    const pattern =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)['pattern']
        : undefined;
    return `searched ${typeof pattern === 'string' ? pattern : 'pattern'} (${opts.files.length} file hint(s))`;
  }
  if ((toolName === 'edit' || toolName === 'write') && opts.files[0]) {
    return `${toolName === 'write' ? 'wrote' : 'edited'} ${opts.files[0]}`;
  }
  const firstLine = normalizeWhitespace(content.split(/\r?\n/).find((line) => line.trim()) ?? '');
  return firstLine ? firstLine.slice(0, 220) : `${toolName} returned no text`;
}

export function updateRepeatedReadSignals(
  state: ContextEvidenceState,
  metadata: ToolOutputMetadata,
): void {
  if (metadata.toolName !== 'read' || metadata.files.length === 0) {
    state.lastReadPath = undefined;
    return;
  }
  const file = metadata.files[0] as string;
  if (state.lastReadPath === file) {
    const existing = state.repeatedReads.find((item) => item.file === file);
    if (existing) {
      existing.count++;
      existing.lastToolUseId = metadata.toolUseId;
    } else {
      state.repeatedReads.push({ file, count: 2, lastToolUseId: metadata.toolUseId });
    }
    if (state.repeatedReads.length > 10) state.repeatedReads.shift();
  }
  state.lastReadPath = file;
}

export function metadataReferencedByText(metadata: ToolOutputMetadata, haystack: string): boolean {
  if (!metadata || typeof metadata !== 'object' || typeof haystack !== 'string') return false;
  if (Array.isArray(metadata.files)) {
    for (const file of metadata.files) {
      if (typeof file !== 'string') continue;
      const f = file.toLowerCase();
      const base = path.basename(file).toLowerCase();
      if (f && haystack.includes(f)) return true;
      if (base && haystack.includes(base)) return true;
    }
  }
  if (Array.isArray(metadata.symbols)) {
    for (const symbol of metadata.symbols) {
      if (
        typeof symbol === 'string' &&
        symbol.length >= 3 &&
        haystack.includes(symbol.toLowerCase())
      )
        return true;
    }
  }
  if (Array.isArray(metadata.errors)) {
    for (const err of metadata.errors) {
      if (typeof err === 'string') {
        const head = err.slice(0, 80).toLowerCase();
        if (head.length >= 12 && haystack.includes(head)) return true;
      }
    }
  }
  return false;
}
