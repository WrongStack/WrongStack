import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Tool, ToolStreamEvent } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { buildChildEnv, expectDefined } from '@wrongstack/core/utils';
import { compileUserRegex } from './_regex.js';
import { makeRootRelativizer, safeResolveReal } from './_util.js';
import { runNative } from './grep-native.js';
import type { GrepInput, GrepOutput } from './grep-types.js';
import { DEFAULT_IGNORE } from './grep-types.js';

export type {
  GrepBackend,
  GrepEngine,
  GrepInput,
  GrepOutput,
  GrepOutputMode,
} from './grep-types.js';

const RG_MAX_QUEUE_CHUNKS = 128;
const RG_MAX_QUEUE_CHARS = 8 * 1024 * 1024;

function isInsideDefaultIgnoredDirectory(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  return relative.split(path.sep).some((segment) => DEFAULT_IGNORE.has(segment));
}

export const grepTool: Tool<GrepInput, GrepOutput> = {
  outputSchema: {
    type: 'object',
    properties: {
      matches: { type: 'array', items: { type: 'string' } },
      count: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' },
      used: { type: 'string', enum: ['rg', 'native'] },
    },
    required: ['matches', 'count', 'truncated', 'used'],
  },
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
    '- Always prefer this over `bash grep` when searching code.\n' +
    '- Result paths are relative to the project root.',
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
    // A missing path used to search nothing and report zero matches — a
    // misleading "not found" for what is really a wrong path.
    if (input.path && !(await fs.stat(base).catch(() => null))) {
      throw new ToolValidationError({
        message: `grep: path "${input.path}" does not exist`,
        field: 'path',
      });
    }
    const ignoreRoot = await fs
      .realpath(ctx.projectRoot ?? ctx.cwd)
      .catch(() => path.resolve(ctx.projectRoot ?? ctx.cwd));
    const ignoreTarget = await fs.realpath(base).catch(() => path.resolve(base));
    const mode = input.output_mode ?? 'content';
    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 200;
    const limit = Math.max(1, Math.min(Math.floor(rawLimit), 2000));
    const validation = compileUserRegex(input.pattern, input.case_insensitive ? 'i' : '');
    if (!validation.ok) {
      throw new ToolValidationError({
        message: `grep: ${validation.reason}`,
        field: 'pattern',
      });
    }

    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    // Match lines are emitted relative to the project root: the absolute
    // prefix is identical on every line and costs context for nothing. Paths
    // outside the root (`safeResolveReal` also admits `~/.wrongstack`) stay
    // absolute — see `makeRootRelativizer`.
    const relativize = makeRootRelativizer(ctx.cwd);
    const rgAvailable = await detectRg();
    // The recursive walkers skip ignored directory entries, but that does not
    // protect the walk root itself. An explicit path such as
    // `packages/app/dist` (or a file below it) therefore leaked build output
    // through the native fallback. Apply the same rule to the resolved search
    // root before selecting an engine so rg and native behavior stay aligned.
    if (isInsideDefaultIgnoredDirectory(ignoreTarget, ignoreRoot)) {
      yield {
        type: 'final',
        output: {
          matches: [],
          count: 0,
          truncated: false,
          used: rgAvailable ? 'rg' : 'native',
        },
      };
      return;
    }
    if (rgAvailable) {
      try {
        yield* runRgStream(input, base, mode, limit, signal, relativize);
        return;
      } catch {
        // fall through to native
      }
    }
    yield { type: 'log', text: 'Falling back to native grep…' };
    const out = await runNative(input, base, mode, limit, signal, relativize);
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

/** Test-only: explicitly set rg availability to test both engines. */
export function __setRgAvailableForTests(available: boolean | undefined): void {
  rgAvailabilityCache = available !== undefined ? Promise.resolve(available) : undefined;
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
  relativize: (absPath: string) => string,
): AsyncGenerator<ToolStreamEvent<GrepOutput>> {
  if (signal.aborted) {
    yield {
      type: 'final',
      output: {
        matches: [],
        count: 0,
        truncated: false,
        used: 'rg',
      },
    };
    return;
  }

  const args: string[] = ['--no-heading', '--with-filename'];
  if (input.case_insensitive) args.push('-i');
  if (mode === 'files_with_matches') args.push('-l');
  if (mode === 'count') args.push('-c');
  // With context, rg interleaves context lines and `--` group separators with
  // the matches. `--null` puts a NUL after the path so a match (`\0N:`) is
  // told apart from context (`\0N-`) — `path:N:` alone is ambiguous when the
  // path itself holds `-N-`. Only match lines count toward `count`/`limit`.
  const withContext = mode === 'content' && Boolean(input.context_lines);
  if (mode === 'content') {
    args.push('-n');
    if (input.context_lines) args.push('-C', String(input.context_lines), '--null');
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
  if (input.glob) {
    const g = input.glob.trim();
    if (g.startsWith('!') || g.startsWith('**/') || g.startsWith('*')) {
      args.push('--glob', g);
    } else {
      args.push('--glob', `**/${g}`);
    }
  }
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
  // rg stdout arrives in pipe chunks, so the same multi-byte boundary split the
  // native walker handles must be decoded with a streaming decoder here too.
  const stdoutDecoder = new StringDecoder('utf8');
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
    const data = stdoutDecoder.write(c);
    if (data.length === 0) return;
    queue.push({ kind: 'out', data });
    queuedChars += data.length;
    wake();
    pauseIfFlooded();
  };
  const onError = (e: Error): void => {
    queue.push({ kind: 'error', data: e.message });
    wake();
  };
  let rgExitCode: number | null = null;
  const onClose = (code: number | null): void => {
    rgExitCode = code;
    // Flush a partial trailing sequence so the final match line is complete.
    const tail = stdoutDecoder.end();
    if (tail.length > 0) {
      queue.push({ kind: 'out', data: tail });
      queuedChars += tail.length;
    }
    queue.push({ kind: 'close', data: '' });
    wake();
  };
  child.stdout?.on('data', onStdoutData);
  child.on('error', onError);
  child.on('close', onClose);

  let pendingBatch: string[] = [];
  // Context after the last kept match stays until its `--` group separator.
  let contextOpen = true;
  const lineNumberSep = /\d+([:-])/y;
  const acceptLine = (raw: string): void => {
    if (!raw) return;
    let line = raw;
    let keep: boolean;
    if (!withContext) {
      totalLines++;
      if (mode === 'count') totalCount += parseRgCountLine(line);
      keep = matches.length < limit;
    } else {
      const nul = raw.indexOf('\0');
      let isMatch = false;
      if (nul !== -1) {
        lineNumberSep.lastIndex = nul + 1;
        isMatch = lineNumberSep.exec(raw)?.[1] === ':';
        line = `${raw.slice(0, nul)}${isMatch ? ':' : '-'}${raw.slice(nul + 1)}`;
      }
      if (isMatch) {
        totalLines++;
        keep = totalLines <= limit;
        if (!keep) contextOpen = false;
      } else {
        if (nul === -1 && totalLines >= limit) contextOpen = false;
        keep = contextOpen;
      }
    }
    if (!keep) return;
    // rg prints `<base><sep>rest`, so the root prefix sits at the start
    // of the line and can be stripped without parsing the line's shape
    // (content / count / files-only all share it).
    const shortened = relativize(line);
    matches.push(shortened);
    pendingBatch.push(shortened);
    batchSinceFlush++;
  };
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
      for (const line of ready.split('\n')) acceptLine(line);
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
      for (const line of buf.split('\n')) acceptLine(line);
    }
    if (pendingBatch.length > 0) {
      yield {
        type: 'partial_output',
        text: pendingBatch.join('\n'),
        data: { matches_so_far: matches.length },
      };
    }
    if (errored) throw new Error('rg: spawn error');
    // rg exits 2 on an error (a pattern its engine rejects — e.g. JS lookaround
    // or backreferences that compileUserRegex accepted — or an unreadable
    // path). With no output that used to surface as "0 matches"; throwing
    // routes the search to the native JS engine instead.
    if (rgExitCode === 2 && totalLines === 0 && !bufOverflow) {
      throw new Error('rg: exited with an error and produced no matches');
    }

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
  if (idx === -1) {
    const direct = Number.parseInt(line.trim(), 10);
    return Number.isFinite(direct) ? direct : 0;
  }
  const n = Number.parseInt(line.slice(idx + 1), 10);
  return Number.isFinite(n) ? n : 0;
}
