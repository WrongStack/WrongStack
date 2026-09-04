import * as fs from 'node:fs/promises';
import { FsError, type Tool, ToolValidationError } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { isBinaryBuffer, safeResolveReal, sha256hex } from './_util.js';
import { getIndexState, searchCodebaseIndex } from './codebase-index/background-indexer.js';
import type { SymbolKind } from './codebase-index/schema.js';
import { codebaseIndexDirOverride } from './codebase-index/writer-helpers.js';

/**
 * Meta key for advanced mode. When `true` in `ctx.meta`, the read tool
 * automatically injects codebase-index symbols for the file being read
 * as a structured `symbols` field. Set via:
 *   ctx.meta['tools.read.advancedMode'] = true
 * A per-call `includeSymbols` parameter overrides this flag.
 */
const ADVANCED_MODE_META_KEY = 'tools.read.advancedMode';

interface ReadInput {
  path: string;
  offset?: number | undefined;
  limit?: number | undefined;
  mode?: 'content' | 'summary' | undefined;
  /**
   * When true, include the codebase-index symbol list for this file
   * as a structured `symbols` field in the result. Overrides the
   * advanced-mode meta flag (`ctx.meta['tools.read.advancedMode']`)
   * per-call when explicitly set. When omitted, the meta flag governs.
   */
  includeSymbols?: boolean | undefined;
}

/**
 * A single indexed code symbol returned alongside file content when
 * advanced mode is on or `includeSymbols` is set. The LLM must treat
 * this as a symbol listing — not as file content.
 */
interface SymbolEntry {
  /** Symbol name (e.g. myFunction, MyClass). */
  name: string;
  /** Kind of symbol (function, class, interface, const, etc.). */
  kind: SymbolKind;
  /** 1-based declaration line in the file. */
  line: number;
  /** 0-based column offset. */
  col: number;
  /** Full signature or declaration text. */
  signature: string;
}

interface ReadOutput {
  text: string;
  total_lines: number;
  encoding: string;
  truncated: boolean;
  cached?: boolean | undefined;
  note?: string | undefined;
  /**
   * Codebase-index symbols for this file, included when advanced mode
   * is active or `includeSymbols` is set. One entry per indexed symbol,
   * sorted by line number. This is a symbol listing — NOT file content.
   */
  symbols?: SymbolEntry[] | undefined;
}

const MAX_BYTES = 5 * 1024 * 1024;

export const readTool: Tool<ReadInput, ReadOutput> = {
  name: 'read',
  category: 'Filesystem',
  description:
    'Read the contents of a file with line numbers. This is the primary way to inspect source code, configuration, or any text file before making changes. ' +
    'Lines are returned 1-indexed in the form `N→content` (line number, then a `→` separator, then the raw line). ' +
    'The `N→` prefix is display-only — always strip it before reusing the text, e.g. never include it in `edit.old_string`. ' +
    'When advanced mode is on or `includeSymbols` is set, the result also includes a `symbols` field ' +
    'listing codebase-index symbol names, kinds, and line numbers for the file (not file content).',
  usageHint:
    'FOUNDATIONAL TOOL — call this before almost any edit operation.\n\n' +
    'Best practices:\n' +
    '- Always read a file before using `edit`, `replace`, or `write` on it (the system often requires it for safety).\n' +
    '- Use `offset` + `limit` for very large files instead of reading everything at once.\n' +
    '- Default limit is generous (2000 lines) but can be increased.\n' +
    '- The output format is designed to be directly usable as context for `edit` operations.\n' +
    '- Set `includeSymbols: true` to also receive the codebase-index symbol listing for the file.\n' +
    "- Enable advanced mode (`ctx.meta['tools.read.advancedMode'] = true`) to auto-inject symbols on every read.",
  selection: {
    doNotUseWhen: 'you need to search many files for matching content.',
    useInstead: ['grep'],
  },
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  icon: 'file',
  maxOutputBytes: 262_144,
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (relative to project root or absolute within project).',
      },
      offset: {
        type: 'integer',
        minimum: 1,
        description: '1-based starting line number. Use together with `limit` for large files.',
      },
      limit: {
        type: 'integer',
        minimum: 0,
        description:
          'Maximum number of lines to return (default 2000). Values above 5000 are clamped to 5000 — page with `offset` for more.',
      },
      mode: {
        type: 'string',
        enum: ['content', 'summary'],
        description:
          'Return full line-numbered content (default) or a compact file summary with imports/exports/symbols.',
      },
      includeSymbols: {
        type: 'boolean',
        description:
          'When true, include the codebase-index symbol list for this file as a structured `symbols` field ' +
          'in the result. Overrides the advanced-mode meta flag per-call.',
      },
    },
    required: ['path'],
  },
  async execute(input, ctx, execOpts) {
    if (!input?.path) {
      throw new ToolValidationError({
        message: 'read: path is required',
        field: 'path',
      });
    }
    const signal = execOpts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();
    const absPath = await safeResolveReal(input.path, ctx);

    // Determine whether to include symbols: per-call param overrides meta flag.
    const shouldIncludeSymbols =
      input.includeSymbols === true ||
      (input.includeSymbols !== false && ctx.meta[ADVANCED_MODE_META_KEY] === true);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new FsError({
          message: `read: file not found "${input.path}"`,
          code: 'FS_READ_FAILED',
          path: absPath,
          context: { errno: 'ENOENT' },
        });
      }
      throw new FsError({
        message: `read: failed to stat "${input.path}": ${toErrorMessage(err)}`,
        code: 'FS_READ_FAILED',
        path: absPath,
        context: { errno: code },
        cause: err,
      });
    }
    if (!stat.isFile()) {
      throw new FsError({
        message: `read: "${input.path}" is not a regular file`,
        code: 'FS_READ_FAILED',
        path: absPath,
        context: { reason: 'not-a-regular-file' },
      });
    }
    if (stat.size > MAX_BYTES) {
      throw new FsError({
        message: `read: file too large (${stat.size} bytes, limit ${MAX_BYTES})`,
        code: 'FS_READ_FAILED',
        path: absPath,
        context: { size: stat.size, limit: MAX_BYTES, reason: 'too-large' },
      });
    }

    const rawOffset =
      typeof input.offset === 'number' && Number.isFinite(input.offset) ? input.offset : 1;
    const offset = Math.max(1, Math.floor(rawOffset));
    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 2000;
    const limit = Math.max(0, Math.min(Math.floor(rawLimit), 5000));
    const prior = getReadRangeRecord(ctx, absPath);
    const requestedEnd = prior
      ? Math.min(offset + limit - 1, prior.totalLines)
      : offset + limit - 1;
    if (
      input.mode !== 'summary' &&
      limit > 0 &&
      prior &&
      offset <= requestedEnd &&
      coversRange(prior, stat.mtimeMs, stat.size, offset, requestedEnd)
    ) {
      ctx.recordRead(absPath, stat.mtimeMs, 'user', ctx.lastReadHash?.(absPath));
      const symResult = shouldIncludeSymbols
        ? await fetchSymbolsForFile(absPath, ctx, signal)
        : undefined;
      return {
        text:
          `[unchanged since previous read: "${input.path}" mtime=${Math.round(stat.mtimeMs)}; ` +
          `requested lines ${offset}-${requestedEnd} were already shown. Use offset/limit for a new range if needed.]`,
        total_lines: prior.totalLines,
        encoding: 'utf8',
        truncated: requestedEnd < prior.totalLines,
        cached: true,
        note: mergeSymbolNote('Repeated read suppressed to save tokens.', symResult?.note),
        ...(symResult?.symbols ? { symbols: symResult.symbols } : {}),
      };
    }

    signal?.throwIfAborted();
    const buf = await fs.readFile(absPath);
    if (isBinaryBuffer(buf)) {
      throw new FsError({
        message: `read: "${input.path}" appears to be binary`,
        code: 'FS_READ_FAILED',
        path: absPath,
        context: { reason: 'binary' },
      });
    }

    const text = buf.toString('utf8');
    // Content hash recorded alongside the mtime: `edit` uses it as the
    // authoritative staleness check (mtime alone has a 2 s tolerance window
    // on Windows). The full file is read even for offset/limit slices, so
    // the hash always covers the whole content.
    const contentHash = sha256hex(text);
    const allLines = text.split(/\r?\n/);
    const total = allLines.length;

    if (input.mode === 'summary') {
      ctx.recordRead(absPath, stat.mtimeMs, 'user', contentHash);
      rememberReadRange(ctx, absPath, stat.mtimeMs, stat.size, total, 1, Math.min(total, 200));
      const symResult = shouldIncludeSymbols
        ? await fetchSymbolsForFile(absPath, ctx, signal)
        : undefined;
      const summary = summarizeFile(input.path, stat.size, allLines);
      return {
        text: summary.text,
        total_lines: total,
        encoding: 'utf8',
        truncated: summary.truncated,
        note: mergeSymbolNote(
          'Summary mode returned compact structure instead of full file content.',
          symResult?.note,
        ),
        ...(symResult?.symbols ? { symbols: symResult.symbols } : {}),
      };
    }
    if (limit === 0) {
      ctx.recordRead(absPath, stat.mtimeMs, 'user', contentHash);
      rememberReadRange(ctx, absPath, stat.mtimeMs, stat.size, total, 1, 0);
      const symResult = shouldIncludeSymbols
        ? await fetchSymbolsForFile(absPath, ctx, signal)
        : undefined;
      return {
        text: '',
        total_lines: total,
        encoding: 'utf8',
        truncated: total > 0,
        ...(symResult?.symbols ? { symbols: symResult.symbols } : {}),
        ...(symResult?.note ? { note: symResult.note } : {}),
      };
    }
    // Offset past EOF: return an explicit message instead of an empty string.
    // Without this, models with weak instruction-following (e.g. k2p7) see an
    // empty result, assume the read failed transiently, and retry the exact
    // same offset indefinitely — a tight tool-use loop that burns iterations
    // and context without making progress.
    if (offset > total) {
      ctx.recordRead(absPath, stat.mtimeMs, 'user', contentHash);
      const symResult = shouldIncludeSymbols
        ? await fetchSymbolsForFile(absPath, ctx, signal)
        : undefined;
      return {
        text: `[offset ${offset} is past end of file "${input.path}" — file has ${total} line(s). Do not retry this offset.]`,
        total_lines: total,
        encoding: 'utf8',
        truncated: false,
        ...(symResult?.symbols ? { symbols: symResult.symbols } : {}),
        ...(symResult?.note ? { note: symResult.note } : {}),
      };
    }

    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const truncated = offset - 1 + slice.length < total;

    const sliceCount = slice.length;
    const width = String(offset + sliceCount - 1).length;
    const parts: string[] = new Array(sliceCount);
    for (let i = 0; i < sliceCount; i++) {
      const numStr = String(offset + i);
      const padLen = width - numStr.length;
      const pad = padLen > 0 ? ' '.repeat(padLen) : '';
      parts[i] = `${pad}${numStr}→${slice[i]}`;
    }
    const numbered = parts.join('\n');

    ctx.recordRead(absPath, stat.mtimeMs, 'user', contentHash);
    rememberReadRange(
      ctx,
      absPath,
      stat.mtimeMs,
      stat.size,
      total,
      offset,
      offset + slice.length - 1,
    );

    const symResult = shouldIncludeSymbols
      ? await fetchSymbolsForFile(absPath, ctx, signal)
      : undefined;
    return {
      text: numbered,
      total_lines: total,
      encoding: 'utf8',
      truncated,
      ...(symResult?.symbols ? { symbols: symResult.symbols } : {}),
      ...(symResult?.note ? { note: symResult.note } : {}),
    };
  },
};

/**
 * Best-effort fetch of codebase-index symbols for a file. Returns
 * sorted symbol entries (or `undefined` when the index is unavailable
 * or has no symbols for this file) and an optional truncation note.
 * Never throws — symbol injection must never break the read operation.
 */
async function fetchSymbolsForFile(
  absPath: string,
  ctx: import('@wrongstack/core/agent').Context,
  signal?: AbortSignal,
): Promise<{ symbols?: SymbolEntry[]; note?: string }> {
  try {
    const state = getIndexState();
    if (!state.ready) return {};

    const { results, total } = await searchCodebaseIndex(
      {
        projectRoot: ctx.projectRoot,
        indexDir: codebaseIndexDirOverride(ctx),
        query: '',
        file: absPath.replace(/\\/g, '/'),
        limit: 500,
      },
      { signal },
    );

    if (results.length === 0) return {};

    const sorted = results
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        line: r.line,
        col: r.col,
        signature: r.signature,
      }))
      .sort((a, b) => a.line - b.line || a.col - b.col);

    const result: { symbols: SymbolEntry[]; note?: string } = { symbols: sorted };
    if (total > results.length) {
      result.note = `Symbol listing truncated to ${results.length} of ${total} entries.`;
    }
    return result;
  } catch {
    return {};
  }
}

/** Merge an optional symbol-truncation note into an existing or absent note field. */
function mergeSymbolNote(
  note: string | undefined,
  symNote: string | undefined,
): string | undefined {
  if (!symNote) return note;
  if (!note) return symNote;
  return `${note} ${symNote}`;
}

interface ReadRangeRecord {
  mtimeMs: number;
  size: number;
  totalLines: number;
  ranges: Array<{ start: number; end: number }>;
}

const READ_RANGES_META_KEY = 'tools.read.ranges.v1';

function getReadRanges(
  ctx: import('@wrongstack/core/agent').Context,
): Record<string, ReadRangeRecord> {
  const existing = ctx.meta[READ_RANGES_META_KEY];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, ReadRangeRecord>;
  }
  const next: Record<string, ReadRangeRecord> = {};
  ctx.meta[READ_RANGES_META_KEY] = next;
  return next;
}

function getReadRangeRecord(
  ctx: import('@wrongstack/core/agent').Context,
  absPath: string,
): ReadRangeRecord | undefined {
  return getReadRanges(ctx)[absPath];
}

const MTIME_TOLERANCE_MS = process.platform === 'win32' ? 2000 : 1;

function rememberReadRange(
  ctx: import('@wrongstack/core/agent').Context,
  absPath: string,
  mtimeMs: number,
  size: number,
  totalLines: number,
  start: number,
  end: number,
): void {
  if (end < start) return;
  const ranges = getReadRanges(ctx);
  const prior = ranges[absPath];
  const nextRanges =
    prior && prior.size === size && Math.abs(prior.mtimeMs - mtimeMs) <= MTIME_TOLERANCE_MS
      ? prior.ranges.slice()
      : [];
  nextRanges.push({ start, end });
  ranges[absPath] = {
    mtimeMs,
    size,
    totalLines,
    ranges: mergeRanges(nextRanges),
  };
}

function coversRange(
  record: ReadRangeRecord,
  mtimeMs: number,
  size: number,
  start: number,
  end: number,
): boolean {
  if (record.size !== undefined && record.size !== size) return false;
  if (Math.abs(record.mtimeMs - mtimeMs) > MTIME_TOLERANCE_MS) return false;
  return record.ranges.some((range) => range.start <= start && range.end >= end);
}

function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function summarizeFile(
  filePath: string,
  bytes: number,
  lines: string[],
): { text: string; truncated: boolean } {
  const interesting: string[] = [];
  const symbolRegex =
    /^(import\s|export\s|class\s|interface\s|type\s|function\s|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s+|async\s+(?:def|function)\s|func\s+|fn\s+|pub\s+(?:fn|struct|enum|trait|type|const)\s+|struct\s+|enum\s+|impl\s+)/;
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (interesting.length >= 80) {
      truncated = true;
      break;
    }
    const trimmed = (lines[i] as string).trim();
    if (symbolRegex.test(trimmed)) {
      interesting.push(`${i + 1}: ${trimmed}`);
    }
  }
  const text = [
    `summary: ${filePath}`,
    `bytes=${bytes}`,
    `total_lines=${lines.length}`,
    interesting.length > 0
      ? `symbols/imports:\n${interesting.join('\n')}`
      : 'symbols/imports: (none detected)',
  ].join('\n');
  return { text, truncated };
}
