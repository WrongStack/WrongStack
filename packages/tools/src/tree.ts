import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolProgressEvent, ToolStreamEvent } from '@wrongstack/core/types';
import { DEFAULT_WALK_IGNORE_DIRS, compileGlob, expectDefined } from '@wrongstack/core/utils';
import { safeResolveReal } from './_util.js';

// Shared artifact/dependency dirs, plus tree-specific privacy dirs — tree can
// be pointed at $HOME, where listing key material is never wanted.
/** Set-backed for O(1) `has()` in the per-entry walk loop. */
const DEFAULT_IGNORE: ReadonlySet<string> = new Set([
  ...DEFAULT_WALK_IGNORE_DIRS,
  '.wrongstack',
  '.ssh',
  '.gnupg',
  '.aws',
]);
const DEFAULT_MAX_ENTRIES = 5_000;
const MAX_TREE_OUTPUT_BYTES = 256 * 1024;

interface TreeInput {
  path?: string | undefined;
  depth?: number | undefined;
  glob?: string | undefined;
  exclude?: string[] | undefined;
  show_files?: boolean | undefined;
  show_dirs?: boolean | undefined;
  show_hidden?: boolean | undefined;
  max_entries?: number | undefined;
}

interface TreeOutput {
  tree: string;
  total_files: number;
  total_dirs: number;
  truncated: boolean;
  path: string;
}

export const treeTool: Tool<TreeInput, TreeOutput> = {
  name: 'tree',
  category: 'Filesystem',
  description:
    'Display a project or subpath directory tree. Use it for structural layout; use index-backed `codebase-search` first for code understanding when it is live.',
  usageHint:
    'DIRECTORY-LAYOUT EXPLORATION:\n\n' +
    '- When `codebase-search` is live, use it first for symbols and concepts; use `tree` when the directory hierarchy itself matters.\n' +
    '- Tune `depth` (default 3) and use `glob`/`exclude` to focus the view.\n' +
    '- Prefer this over raw `bash find` or `glob` + manual reading when you need a quick structural overview.\n' +
    'Output is truncated for very large trees.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  icon: 'tree',
  maxOutputBytes: 262_144,
  timeoutMs: 15_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Root directory to display the tree from (defaults to project root).',
      },
      depth: {
        type: 'integer',
        description: 'Maximum directory depth to traverse (default 3, use 0 for unlimited).',
        minimum: 0,
        maximum: 20,
      },
      glob: {
        type: 'string',
        description: 'Only include files matching this glob pattern.',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of directory names to completely ignore.',
      },
      show_files: {
        type: 'boolean',
        description: 'Whether to show individual files (default true).',
      },
      show_dirs: {
        type: 'boolean',
        description: 'Whether to show directories (default true).',
      },
      show_hidden: {
        type: 'boolean',
        description: 'Show hidden files starting with . (default: false)',
      },
      max_entries: {
        type: 'integer',
        description: `Maximum entries retained in the rendered tree (default ${DEFAULT_MAX_ENTRIES}).`,
        minimum: 1,
        maximum: 50_000,
      },
    },
  },
  async execute(input, ctx, opts) {
    let final: TreeOutput | undefined;
    const executeStream = treeTool.executeStream;
    if (!executeStream) throw new Error('treeTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('tree: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<TreeOutput>> {
    const basePath = input.path ? await safeResolveReal(input.path, ctx) : ctx.cwd;
    const maxDepth = input.depth ?? 3;
    const showFiles = input.show_files ?? true;
    const showDirs = input.show_dirs ?? true;
    const showHidden = input.show_hidden ?? false;
    const exclude = new Set([...DEFAULT_IGNORE, ...(input.exclude ?? [])]);
    const globRe = input.glob ? compileGlob(input.glob) : undefined;
    const maxEntries = input.max_entries ?? DEFAULT_MAX_ENTRIES;
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;

    const lines: string[] = [basePath];
    const totals = { totalFiles: { value: 0 }, totalDirs: { value: 0 } };
    const retention = {
      entries: 0,
      outputBytes: Buffer.byteLength(basePath, 'utf8'),
      maxEntries,
      maxOutputBytes: MAX_TREE_OUTPUT_BYTES,
      truncated: false,
    };

    // Walker pushes progress into an async queue; the generator drains it.
    const queue: ToolProgressEvent[] = [];
    const FLUSH_EVERY = 200; // emit metric every 200 entries seen
    let lastEmittedTotal = 0;

    const tickProgress = () => {
      const seen = totals.totalFiles.value + totals.totalDirs.value;
      if (seen - lastEmittedTotal >= FLUSH_EVERY) {
        queue.push({
          type: 'metric',
          text: `${seen} entries`,
          data: { files: totals.totalFiles.value, dirs: totals.totalDirs.value },
        });
        lastEmittedTotal = seen;
      }
    };

    const walkPromise = walkDir(basePath, 0, {
      maxDepth,
      exclude,
      showFiles,
      showDirs,
      showHidden,
      globRe,
      basePath,
      lines,
      prefix: '',
      isLast: true,
      totalFiles: totals.totalFiles,
      totalDirs: totals.totalDirs,
      onProgress: tickProgress,
      retention,
      signal,
    });

    // Race the walk against periodic flushes — yield metrics while it runs.
    let walkDone = false;
    void walkPromise.then(
      () => {
        walkDone = true;
      },
      () => {
        walkDone = true;
      },
    );

    while (!walkDone || queue.length > 0) {
      if (queue.length > 0) {
        yield expectDefined(queue.shift());
      } else {
        // Race the walk completion against a short tick so we don't busy-
        // spin while the producer fills the queue. Previously the
        // setTimeout was never cleared when walkPromise won — one stray
        // timer per drain iteration accumulated on the event loop.
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const poll = new Promise<void>((r) => {
          pollTimer = setTimeout(r, 50);
        });
        try {
          await Promise.race([walkPromise, poll]).catch(() => undefined);
        } finally {
          if (pollTimer) clearTimeout(pollTimer);
        }
      }
    }
    await walkPromise; // surface any error

    yield {
      type: 'final',
      output: {
        tree: lines.join('\n'),
        total_files: totals.totalFiles.value,
        total_dirs: totals.totalDirs.value,
        truncated: retention.truncated,
        path: basePath,
      },
    };
  },
};

/** Match a tree glob against the basename and a POSIX project-relative path. */
function matchesTreeGlob(globRe: RegExp, fileName: string, absPath: string, basePath: string): boolean {
  if (globRe.test(fileName)) return true;
  const rel = path.relative(basePath, absPath);
  const posixRel =
    !rel || rel.startsWith('..') || path.isAbsolute(rel)
      ? absPath.split(path.sep).join('/')
      : rel.split(path.sep).join('/');
  return globRe.test(posixRel);
}

interface WalkOptions {
  maxDepth: number;
  exclude: Set<string>;
  showFiles: boolean;
  showDirs: boolean;
  showHidden: boolean;
  globRe?: RegExp | undefined;
  basePath: string;
  lines: string[];
  prefix: string;
  isLast: boolean;
  totalFiles: { value: number };
  totalDirs: { value: number };
  onProgress?: (() => void) | undefined;
  retention: {
    entries: number;
    outputBytes: number;
    maxEntries: number;
    maxOutputBytes: number;
    truncated: boolean;
  };
  signal: AbortSignal;
}

async function walkDir(dir: string, depth: number, opts: WalkOptions): Promise<void> {
  opts.signal.throwIfAborted();
  if (opts.retention.truncated) return;
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => [] as import('node:fs').Dirent[]);

  const filtered = entries.filter((e) => {
    if (!opts.showHidden && e.name.startsWith('.')) return false;
    if (opts.exclude.has(e.name)) return false;
    if (e.isFile() && opts.globRe) {
      const abs = path.join(dir, e.name);
      if (!matchesTreeGlob(opts.globRe, e.name, abs, opts.basePath)) return false;
    }
    return true;
  });

  // Count this directory's entries — every walkDir invocation owns exactly the
  // direct children of `dir`, so counting unconditionally counts each entry
  // once. (A previous `depth > 0` guard silently excluded the root's direct
  // children from total_files/total_dirs: the root call passes depth 0.)
  // Single pass: count dirs and files simultaneously instead of two
  // separate .filter() scans over the same array.
  let dirCount = 0;
  let fileCount = 0;
  for (const e of filtered) {
    if (e.isDirectory()) dirCount++;
    else if (e.isFile()) fileCount++;
  }
  opts.totalDirs.value += dirCount;
  opts.totalFiles.value += fileCount;
  opts.onProgress?.();

  const items = filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < items.length; i++) {
    opts.signal.throwIfAborted();
    if (opts.retention.truncated) return;
    const entry = items[i];
    /* v8 ignore next -- i is bounded by items.length, so entry is always defined; defensive. */
    if (!entry) continue;
    const isLast = i === items.length - 1;
    const connector = opts.isLast ? '    ' : '│   ';
    const branch = isLast ? '└── ' : '├── ';
    const displayName = entry.name + (entry.isDirectory() ? '/' : '');

    if (!opts.showDirs && entry.isDirectory()) continue;
    if (!opts.showFiles && entry.isFile()) continue;

    const line = opts.prefix + branch + displayName;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (
      opts.retention.entries >= opts.retention.maxEntries ||
      opts.retention.outputBytes + lineBytes > opts.retention.maxOutputBytes
    ) {
      opts.retention.truncated = true;
      return;
    }
    opts.lines.push(line);
    opts.retention.entries++;
    opts.retention.outputBytes += lineBytes;

    if (entry.isDirectory() && (opts.maxDepth === 0 || depth < opts.maxDepth)) {
      const childPrefix = opts.prefix + connector;
      await walkDir(path.join(dir, entry.name), depth + 1, {
        ...opts,
        prefix: childPrefix,
        isLast,
      });
    }
  }
}
