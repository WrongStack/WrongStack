import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import {
  buildChildEnv,
  compileGlob,
  DEFAULT_WALK_IGNORE_DIRS,
  expectDefined,
} from '@wrongstack/core/utils';
import { mapWithConcurrency } from './_concurrency.js';
import { capSubject, compileUserRegex } from './_regex.js';
import { isBinaryBuffer, safeResolveReal } from './_util.js';
import { loadGitignoreMatcher } from './codebase-index/gitignore.js';

interface GrepInput {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  output_mode?: 'content' | 'files_with_matches' | 'count' | undefined;
  context_lines?: number | undefined;
  case_insensitive?: boolean | undefined;
  limit?: number | undefined;
}

interface GrepOutput {
  matches: string[];
  count: number;
  truncated: boolean;
  used: 'rg' | 'native';
}

/** Set-backed for O(1) `has()` in the per-entry native walk loop. */
const DEFAULT_IGNORE: ReadonlySet<string> = new Set(DEFAULT_WALK_IGNORE_DIRS);
const NATIVE_SCAN_CONCURRENCY = 32;
const NATIVE_READ_CHUNK_BYTES = 64 * 1024;
const NATIVE_MAX_FILE_BYTES = 1_000_000;
const RG_MAX_QUEUE_CHUNKS = 128;
const RG_MAX_QUEUE_CHARS = 8 * 1024 * 1024;

export const grepTool: Tool<GrepInput, GrepOutput> = {
  name: 'grep',
  category: 'Search',
  description:
    'Search exact file contents using a regular expression. Use index-backed `codebase-search` first for symbol or concept discovery when it is live. ' +
    'Prefers ripgrep for speed and features when available.',
  usageHint:
    'EXACT-TEXT AND REGEX SEARCH:\n\n' +
    '- When `codebase-search` is live, use it first for symbols and concepts; use `grep` for exact text, regexes, unsupported content, and concrete usage sites.\n' +
    '- `pattern` is a regular expression.\n' +
    '- Use `output_mode: "content"` (default) to get matching lines with context.\n' +
    '- Use `"files_with_matches"` when you only need the list of files.\n' +
    '- Use `"count"` for quick statistics.\n' +
    '- `glob` and `path` let you narrow the search scope significantly.\n' +
    '- Always prefer this over `bash grep` when searching code.',
  selection: {
    doNotUseWhen: 'you only need to locate files by name or path pattern.',
    useInstead: ['glob'],
  },
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  icon: 'search',
  maxOutputBytes: 131_072,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for in file contents.',
      },
      path: {
        type: 'string',
        description: 'Limit search to this directory or file (relative to project root).',
      },
      glob: {
        type: 'string',
        description: 'Glob filter for which files to include (e.g. "**/*.ts", "src/**").',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Return style: detailed matches, just file list, or count only.',
      },
      context_lines: {
        type: 'integer',
        description: 'How many lines of surrounding context to include with each match.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Ignore case when matching.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of matches to return.',
      },
    },
    required: ['pattern'],
  },
  async execute(input, ctx, opts) {
    let final: GrepOutput | undefined;
    const executeStream = grepTool.executeStream;
    if (!executeStream) throw new Error('grepTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('grep: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<GrepOutput>> {
    if (!input?.pattern) {
      throw new ToolValidationError({
        message: 'grep: pattern is required',
        field: 'pattern',
      });
    }
    // `safeResolveReal`, not `safeResolve`: the syntactic check passes a
    // junction/symlink that lands inside the project as a STRING while
    // resolving outside it, and both search paths then read through it —
    // `readdirSync` enumerates the outside directory and `rg` is handed the
    // same base. The walk's per-entry `isSymbolicLink()` skip protects
    // entries found DURING the walk, not the walk root. `glob.ts:69` was
    // upgraded and carries a regression test for exactly this case
    // (glob.test.ts:183); grep was missed.
    const base = input.path ? await safeResolveReal(input.path, ctx) : ctx.cwd;
    const mode = input.output_mode ?? 'content';
    const limit = Math.max(1, Math.min(input.limit ?? 200, 2000));
    const validation = compileUserRegex(input.pattern, input.case_insensitive ? 'i' : '');
    if (!validation.ok) {
      throw new ToolValidationError({
        message: `grep: ${validation.reason}`,
        field: 'pattern',
      });
    }

    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    const rgAvailable = await detectRg();
    if (rgAvailable) {
      try {
        yield* runRgStream(input, base, mode, limit, signal);
        return;
      } catch {
        // fall through to native
      }
    }
    yield { type: 'log', text: 'Falling back to native grep…' };
    const out = await runNative(input, base, mode, limit, signal);
    yield { type: 'final', output: out };
  },
};

/**
 * Memoized rg availability probe. The binary does not appear or vanish
 * mid-process, so one `rg --version` spawn per process is enough — previously
 * every grep call paid a fresh probe spawn. The probe runs under its own short
 * timeout signal (NOT the caller's abort signal): caching a `false` produced
 * by an aborted first call would permanently downgrade grep to the native
 * fallback.
 */
let rgAvailabilityCache: Promise<boolean> | undefined;

/** Test-only: forget the cached rg availability so mocks can vary per test. */
export function __resetRgDetectionForTests(): void {
  rgAvailabilityCache = undefined;
}

function detectRg(): Promise<boolean> {
  rgAvailabilityCache ??= new Promise((resolve) => {
    try {
      const p = spawn('rg', ['--version'], {
        env: buildChildEnv(),
        stdio: 'ignore',
        signal: AbortSignal.timeout(10_000),
        windowsHide: true,
      });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return rgAvailabilityCache;
}

async function* runRgStream(
  input: GrepInput,
  base: string,
  mode: 'content' | 'files_with_matches' | 'count',
  limit: number,
  signal: AbortSignal,
): AsyncGenerator<ToolStreamEvent<GrepOutput>> {
  const args: string[] = ['--no-heading'];
  if (input.case_insensitive) args.push('-i');
  if (mode === 'files_with_matches') args.push('-l');
  if (mode === 'count') args.push('-c');
  if (mode === 'content') {
    args.push('-n');
    if (input.context_lines) args.push('-C', String(input.context_lines));
  }
  for (const ignored of DEFAULT_IGNORE) {
    args.push('--glob', `!**/${ignored}/**`);
  }
  // rg only honors .gitignore inside a git repository; pass it explicitly so
  // non-repo trees (scratch dirs, exported archives) get the same pruning as
  // repos and as the native fallback.
  const gitignorePath = path.join(base, '.gitignore');
  if (
    await fs.access(gitignorePath).then(
      () => true,
      () => false,
    )
  ) {
    args.push('--ignore-file', gitignorePath);
  }
  if (input.glob) args.push('--glob', input.glob);
  args.push('--', input.pattern, base);

  const matches: string[] = [];
  let buf = '';
  let totalLines = 0;
  let totalCount = 0;
  let batchSinceFlush = 0;
  const FLUSH_AT = 16; // yield a partial_output every 16 matches
  // Cap on the in-progress line buffer. Without this, a single huge "line"
  // (e.g. a file with no newlines under a symlink) plus a fast producer
  // would let `buf` grow unbounded. 1 MB comfortably holds any realistic
  // grep hit; beyond that we kill the child and surface a truncation.
  const MAX_BUF_BYTES = 1_000_000;
  let bufOverflow = false;

  const child = spawn('rg', args, {
    signal,
    env: buildChildEnv(),
    // rg diagnostics are not part of the tool result. Ignoring stderr avoids
    // an unread pipe filling up and pinning the child when rg reports many
    // filesystem errors.
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  type Chunk = { kind: 'out' | 'close' | 'error'; data: string };
  const queue: Chunk[] = [];
  let queuedChars = 0;
  let waiter: (() => void) | undefined;
  let paused = false;
  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  };
  const pauseIfFlooded = (): void => {
    if (paused || (queue.length < RG_MAX_QUEUE_CHUNKS && queuedChars < RG_MAX_QUEUE_CHARS)) return;
    paused = true;
    child.stdout?.pause();
  };
  const resumeIfDrained = (): void => {
    if (!paused || queue.length >= RG_MAX_QUEUE_CHUNKS || queuedChars >= RG_MAX_QUEUE_CHARS) return;
    paused = false;
    child.stdout?.resume();
  };
  const onStdoutData = (c: Buffer): void => {
    const data = c.toString();
    queue.push({ kind: 'out', data });
    queuedChars += data.length;
    wake();
    pauseIfFlooded();
  };
  const onError = (e: Error): void => {
    queue.push({ kind: 'error', data: e.message });
    wake();
  };
  const onClose = (): void => {
    queue.push({ kind: 'close', data: '' });
    wake();
  };
  child.stdout?.on('data', onStdoutData);
  child.on('error', onError);
  child.on('close', onClose);

  let pendingBatch: string[] = [];
  let errored = false;
  let closed = false;
  try {
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>((r) => {
          waiter = r;
        });
      }
      const c = expectDefined(queue.shift());
      queuedChars = Math.max(0, queuedChars - c.data.length);
      resumeIfDrained();
      if (c.kind === 'error') {
        errored = true;
        continue;
      }
      if (c.kind === 'close') {
        closed = true;
        break;
      }
      buf += c.data;
      // Guard against a pathological producer (e.g. matching a huge binary
      // without newlines) pinning memory. Kill the child and mark the result
      // truncated; whatever we already captured stays intact.
      if (buf.length > MAX_BUF_BYTES && !bufOverflow) {
        bufOverflow = true;
        buf = buf.slice(-MAX_BUF_BYTES);
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
      const idx = buf.lastIndexOf('\n');
      if (idx === -1) continue;
      const ready = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      for (const line of ready.split('\n')) {
        if (!line) continue;
        totalLines++;
        if (mode === 'count') totalCount += parseRgCountLine(line);
        if (matches.length < limit) {
          matches.push(line);
          pendingBatch.push(line);
          batchSinceFlush++;
        }
      }
      if (batchSinceFlush >= FLUSH_AT) {
        yield {
          type: 'partial_output',
          text: pendingBatch.join('\n'),
          data: { matches_so_far: matches.length },
        };
        pendingBatch = [];
        batchSinceFlush = 0;
      }
    }

    if (buf.trim()) {
      for (const line of buf.split('\n')) {
        if (!line) continue;
        totalLines++;
        if (mode === 'count') totalCount += parseRgCountLine(line);
        if (matches.length < limit) {
          matches.push(line);
          pendingBatch.push(line);
        }
      }
    }
    if (pendingBatch.length > 0) {
      yield {
        type: 'partial_output',
        text: pendingBatch.join('\n'),
        data: { matches_so_far: matches.length },
      };
    }
    if (errored) throw new Error('rg: spawn error');

    yield {
      type: 'final',
      output: {
        matches,
        count: mode === 'count' ? totalCount : totalLines,
        truncated: totalLines > limit || bufOverflow,
        used: 'rg',
      },
    };
  } finally {
    // A tool executor may abandon the async generator after any partial
    // output. Detach first so a still-running rg cannot keep filling the
    // closed-over queue, then terminate it if no close event was observed.
    child.stdout?.off('data', onStdoutData);
    child.off('error', onError);
    child.off('close', onClose);
    child.stdout?.destroy();
    queue.length = 0;
    queuedChars = 0;
    waiter = undefined;
    if (!closed && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
    }
  }
}

function parseRgCountLine(line: string): number {
  const idx = line.lastIndexOf(':');
  if (idx === -1) return 0;
  const n = Number.parseInt(line.slice(idx + 1), 10);
  return Number.isFinite(n) ? n : 0;
}

async function runNative(
  input: GrepInput,
  base: string,
  mode: 'content' | 'files_with_matches' | 'count',
  limit: number,
  signal: AbortSignal,
): Promise<GrepOutput> {
  const flags = input.case_insensitive ? 'i' : '';
  const compiled = compileUserRegex(input.pattern, flags);
  if (!compiled.ok) {
    throw new ToolValidationError({
      message: `grep: ${compiled.reason}`,
      field: 'pattern',
    });
  }
  const re = compiled.regex;
  const globRe = input.glob ? compileGlob(input.glob) : null;
  // rg honors .gitignore natively; give the fallback the same pruning so a
  // project whose artifacts aren't in DEFAULT_IGNORE isn't scanned in full.
  const isGitIgnored = await loadGitignoreMatcher(base);
  const matches: string[] = [];
  const countOnlyFirstHit = mode === 'count' && limit === 1;
  const maxBytes =
    mode === 'content' ? NATIVE_MAX_FILE_BYTES : Math.min(NATIVE_MAX_FILE_BYTES, 256 * 1024);
  let total = 0;
  let stopped = false;

  const scanFile = async (full: string, name: string): Promise<void> => {
    if (stopped || signal.aborted) return;
    if (globRe && !globRe.test(name) && !globRe.test(full)) return;
    if (globRe) globRe.lastIndex = 0;

    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.size > maxBytes || stopped || signal.aborted) return;

      const file = await fs.open(full, 'r');
      try {
        let bytesReadTotal = 0;
        let lineNumber = 0;
        let fileHits = 0;
        let leftover = '';
        let binaryChecked = false;
        const buffer = Buffer.allocUnsafe(Math.min(NATIVE_READ_CHUNK_BYTES, maxBytes));

        while (!stopped && !signal.aborted && bytesReadTotal < maxBytes) {
          const remaining = maxBytes - bytesReadTotal;
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, remaining),
            null,
          );
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          if (!binaryChecked) {
            binaryChecked = true;
            if (isBinaryBuffer(chunk)) return;
          }
          bytesReadTotal += bytesRead;
          const text = leftover + chunk.toString('utf8');
          const lines = text.split(/\r?\n/);
          leftover = lines.pop() ?? '';

          for (const rawLine of lines) {
            if (stopped || signal.aborted) break;
            lineNumber++;
            const ln = capSubject(rawLine);
            re.lastIndex = 0;
            if (!re.test(ln)) continue;

            fileHits++;
            total++;

            if (mode === 'content') {
              if (matches.length < limit) matches.push(`${full}:${lineNumber}:${ln}`);
            } else if (mode === 'files_with_matches') {
              if (fileHits === 1 && matches.length < limit) matches.push(full);
              break;
            } else if (fileHits === 1 && matches.length < limit) {
              matches.push(`${full}:${countOnlyFirstHit ? 1 : 0}`);
            }

            if (countOnlyFirstHit || (mode !== 'content' && matches.length >= limit)) {
              stopped = true;
              break;
            }
          }

          if (mode === 'files_with_matches' && fileHits > 0) break;
        }

        if (!stopped && !signal.aborted && leftover.length > 0) {
          lineNumber++;
          const ln = capSubject(leftover);
          re.lastIndex = 0;
          if (re.test(ln)) {
            fileHits++;
            total++;
            if (mode === 'content') {
              if (matches.length < limit) matches.push(`${full}:${lineNumber}:${ln}`);
            } else if (mode === 'files_with_matches') {
              if (matches.length < limit) matches.push(full);
            } else if (matches.length < limit) {
              matches.push(`${full}:${countOnlyFirstHit ? 1 : fileHits}`);
            }
          }
        }

        if (fileHits > 0) {
          if (mode === 'count') {
            const idx = matches.findIndex((entry) => entry.startsWith(`${full}:`));
            if (idx !== -1) matches[idx] = `${full}:${fileHits}`;
          }
          if (mode === 'files_with_matches' && matches.length >= limit) stopped = true;
        }

        if (mode === 'content' && matches.length >= limit) stopped = true;
        if (mode === 'count' && matches.length >= limit && (countOnlyFirstHit || mode !== 'count'))
          stopped = true;
      } finally {
        await file.close();
      }
    } catch {
      // skip read errors
    }
  };

  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    if (stopped || signal.aborted) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files: Array<{ full: string; name: string }> = [];
    const subdirs: Array<{ full: string; rel: string }> = [];
    for (const e of entries) {
      if (stopped) return;
      if (DEFAULT_IGNORE.has(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isGitIgnored(rel, true)) continue;
        subdirs.push({ full, rel });
      } else if (e.isFile()) {
        if (isGitIgnored(rel, false)) continue;
        files.push({ full, name: e.name });
      }
    }
    await mapWithConcurrency(files, NATIVE_SCAN_CONCURRENCY, ({ full, name }) =>
      scanFile(full, name),
    );
    await mapWithConcurrency(subdirs, Math.min(16, NATIVE_SCAN_CONCURRENCY), ({ full, rel }) =>
      walk(full, rel),
    );
  };
  await walk(base, '');

  return {
    matches,
    count: total,
    truncated: stopped,
    used: 'native',
  };
}
