import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compileGlob, DEFAULT_WALK_IGNORE_DIRS } from '@wrongstack/core/utils';
import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { mapWithConcurrency } from './_concurrency.js';
import { loadGitignoreMatcher } from './codebase-index/gitignore.js';
import { assertRealInsideRoot, safeResolveReal } from './_util.js';

interface GlobInput {
  pattern: string;
  path?: string | undefined;
  limit?: number | undefined;
}

interface GlobOutput {
  files: string[];
  truncated: boolean;
}

/** Set-backed for O(1) `has()` in the per-entry walk loop. */
const DEFAULT_IGNORE: ReadonlySet<string> = new Set(DEFAULT_WALK_IGNORE_DIRS);
const WALK_CONCURRENCY = 16;

export const globTool: Tool<GlobInput, GlobOutput> = {
  name: 'glob',
  category: 'Filesystem',
  description:
    'Find files by path pattern. Results are sorted by modification time, newest first, ' +
    'so when the list is truncated at `limit` it is the oldest files that are dropped (recency-biased). ' +
    'Use index-backed `codebase-search` first for code symbols or concepts when it is live.',
  usageHint:
    'PATH DISCOVERY AND SEARCH SCOPING:\n\n' +
    '- When `codebase-search` is live, use it first for code concepts; use `glob` for filenames, path patterns, and non-indexed files.\n' +
    '- Combine with `path` and `limit`.\n' +
    '- Default ignores common build/dependency directories.\n' +
    'Much more efficient than shell `find` for most use cases inside the agent.',
  selection: {
    doNotUseWhen: 'you need to search inside file contents.',
    useInstead: ['grep'],
  },
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  icon: 'folder',
  maxOutputBytes: 65_536,
  timeoutMs: 15_000,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match (e.g. "**/*.ts", "src/**").',
      },
      path: {
        type: 'string',
        description: 'Base directory to search from (defaults to project root).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        description:
          'Maximum number of results to return (default 1000, max 5000). Results are sorted by ' +
          'mtime descending, so truncation keeps the most recently modified files.',
      },
    },
    required: ['pattern'],
  },
  async execute(input, ctx, opts) {
    if (!input?.pattern) {
      throw new ToolValidationError({
        message: 'glob: pattern is required',
        field: 'pattern',
      });
    }
    const signal = opts?.signal ?? ctx?.signal;
    if (signal?.aborted) {
      return { files: [], truncated: true };
    }
    // `safeResolveReal` validates that the input base — even if symlinked —
    // resolves to a real path inside the project root (or `~/.wrongstack`).
    // Throws on escape, matching how single-file tools (`read`, `edit`,
    // `write`) reject out-of-root paths: the caller named the base explicitly.
    const base = input.path ? await safeResolveReal(input.path, ctx) : ctx.cwd;
    const limit = Math.max(1, Math.min(input.limit ?? 1000, 5000));

    // Full gitignore semantics (globs, anchors, negation, dir-only rules)
    // rooted at the walk base — a project whose build output isn't in the
    // static DEFAULT_IGNORE list would otherwise be walked in full.
    const isGitIgnored = await loadGitignoreMatcher(base);
    const re = compileGlob(input.pattern);

    const results: { rel: string; mtime: number }[] = [];
    let truncated = false;
    const pushResult = async (full: string): Promise<void> => {
      // Bail before stat if a concurrent worker has already filled the budget —
      // the limit is a global cap across all parallel walkers, not per-worker.
      if (signal?.aborted || truncated || results.length >= limit) {
        truncated = true;
        return;
      }
      try {
        const st = await fs.stat(full);
        // Re-check after the await: another worker may have filled the budget
        // while we were waiting on fs.stat.
        if (truncated || results.length >= limit) {
          truncated = true;
          return;
        }
        results.push({ rel: full, mtime: st.mtimeMs });
        if (results.length >= limit) truncated = true;
      } catch {
        // skip stat error
      }
    };
    const walk = async (dir: string, relPrefix: string): Promise<void> => {
      // Abort check per directory: a huge tree walk must stop promptly on
      // Ctrl+C instead of running to completion with a discarded result.
      if (signal?.aborted) {
        truncated = true;
        return;
      }
      /* v8 ignore start -- the inner limit guards (file push + post-recursion return) always stop first; this re-entry guard is defensive. */
      if (results.length >= limit) {
        truncated = true;
        return;
      }
      /* v8 ignore stop */
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const subdirs: Array<{ full: string; rel: string }> = [];
      const matchedFiles: string[] = [];
      for (const e of entries) {
        const name = e.name;
        if (DEFAULT_IGNORE.has(name)) continue;
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const full = path.join(dir, name);
        if (e.isDirectory()) {
          if (isGitIgnored(rel, true)) continue;
          subdirs.push({ full, rel });
        } else if (e.isFile()) {
          if (isGitIgnored(rel, false)) continue;
          re.lastIndex = 0;
          if (re.test(rel) || (re.lastIndex = 0, re.test(name))) {
            matchedFiles.push(full);
          }
        } else if (e.isSymbolicLink()) {
          try {
            const st = await fs.stat(full);
            if (st.isDirectory()) {
              if (isGitIgnored(rel, true)) continue;
              // CWE-59 containment: a symlink inside the workspace can point
              // outside it. Before recursing into it (or including the
              // resolved file in results), realpath the symlink and verify
              // its target is still inside the project root. Skip silently
              // on escape so a single bad symlink doesn't poison the whole
              // walk.
              const real = await fs.realpath(full);
              await assertRealInsideRoot(real, ctx);
              subdirs.push({ full, rel });
            } else if (st.isFile()) {
              if (isGitIgnored(rel, false)) continue;
              const real = await fs.realpath(full);
              await assertRealInsideRoot(real, ctx);
              re.lastIndex = 0;
              if (re.test(rel) || (re.lastIndex = 0, re.test(name))) matchedFiles.push(full);
            }
          } catch {
            // Skip broken symlink, stat error, OR out-of-root target. All
            // three should fail the walk without aborting the whole search.
          }
        }
        if (truncated) return;
      }
      await mapWithConcurrency(matchedFiles, WALK_CONCURRENCY, pushResult);
      if (truncated) return;
      // Subdir walks: each one re-checks the limit at entry (re-entry guard),
      // but we also stop dispatching new walks once truncated, so siblings of
      // a hit-limit subdir don't keep adding results.
      const remainingSubdirs = truncated ? [] : subdirs;
      await mapWithConcurrency(remainingSubdirs, WALK_CONCURRENCY, ({ full, rel }) =>
        walk(full, rel),
      );
    };
    await walk(base, '');
    results.sort((a, b) => b.mtime - a.mtime);
    return { files: results.map((r) => r.rel), truncated };
  },
};
