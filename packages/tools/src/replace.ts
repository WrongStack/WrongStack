import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import {
  atomicWrite,
  buildChildEnv,
  compileGlob,
  detectNewlineStyle,
  expectDefined,
  normalizeToLf,
  toStyle,
  unifiedDiff,
} from '@wrongstack/core/utils';
import { compileUserRegex } from './_regex.js';
import { isBinaryBuffer, safeResolveReal, sha256hex, truncateDiffPayload } from './_util.js';
import { mapWithConcurrency } from './_concurrency.js';
import { enqueueReindex } from './codebase-index/background-indexer.js';

/** Byte budget for the combined per-file diff payload — matches `maxOutputBytes`. */
const MAX_DIFF_BYTES = 262_144;

interface ReplaceInput {
  pattern: string;
  replacement: string;
  files: string | string[];
  glob?: string | undefined;
  replace_all?: boolean | undefined;
  dry_run?: boolean | undefined;
}

interface ReplaceOutput {
  files_modified: number;
  total_replacements: number;
  results: { path: string; replacements: number; diff?: string | undefined }[];
  dry_run: boolean;
  /** Set when the combined diff payload was truncated to the output budget. */
  note?: string | undefined;
}

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

export const replaceTool: Tool<ReplaceInput, ReplaceOutput> = {
  name: 'replace',
  category: 'Transform',
  description:
    'Perform a search-and-replace across multiple files using a regex pattern. ' +
    'This is a powerful bulk transformation tool. Dry-run is ON by default — set `dry_run: false` to apply changes.',
  usageHint:
    'DANGEROUS IF USED CARELESSLY — review the diff output carefully.\n\n' +
    'Recommended workflow:\n' +
    '1. Run without `dry_run: false` first to see exactly what would change (dry-run is the default).\n' +
    '2. Review the diff output, then re-run with `dry_run: false` to apply.\n' +
    '3. Use a specific enough `pattern` (and `glob` / `files`) to avoid accidental broad changes.\n' +
    '4. `replace_all` controls whether only the first match per file or all matches are replaced.\n' +
    '5. `replacement` supports regex substitutions: `$1`–`$9` insert capture groups, `$&` inserts the whole match, and `$$` inserts a literal dollar sign.\n' +
    'This tool is excellent for large-scale refactors (renaming, import updates, etc.) but must be used with caution.',
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The file scope being rewritten, not the pattern: a trust rule should say
  // where a bulk replace may run.
  subjectKey: 'files',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'edit',
  timeoutMs: 30_000,
  maxOutputBytes: 262_144,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to match' },
      replacement: {
        type: 'string',
        description:
          'Replacement string. Supports `$1`–`$9` (capture groups), `$&` (whole match), and `$$` (literal dollar sign) — same semantics as JavaScript String.replace.',
      },
      files: {
        type: 'string',
        description: 'File(s) to target: single path, comma-separated list, or glob pattern',
      },
      glob: { type: 'string', description: 'Additional glob filter (e.g. "*.ts")' },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences in each file (default: true)',
      },
      dry_run: { type: 'boolean', description: 'Preview changes without writing (default: true)' },
    },
    required: ['pattern', 'replacement', 'files'],
  },
  async execute(input: ReplaceInput, ctx: Context, opts?: { signal?: AbortSignal }) {
    if (!input?.pattern) {
      throw new ToolValidationError({
        message: 'replace: pattern is required',
        field: 'pattern',
      });
    }
    if (input.replacement === undefined) {
      throw new ToolValidationError({
        message: 'replace: replacement is required',
        field: 'replacement',
      });
    }
    if (!input?.files) {
      throw new ToolValidationError({
        message: 'replace: files is required',
        field: 'files',
      });
    }

    const signal = opts?.signal ?? ctx.signal;
    signal?.throwIfAborted();

    const replaceAll = input.replace_all ?? true;
    // Always compile with 'g' so matchAll() works — matchAll throws
    // TypeError on non-global regexes. The replaceAll flag controls
    // how many matches we act on, not whether the regex is global.
    const compiled = compileUserRegex(input.pattern, 'g');
    if (!compiled.ok) {
      throw new ToolValidationError({
        message: `replace: ${compiled.reason}`,
        field: 'pattern',
      });
    }
    const re = compiled.regex;
    const globRe = input.glob ? compileGlob(input.glob) : null;
    const dryRun = input.dry_run ?? true;

    const filesInput = Array.isArray(input.files) ? input.files.join(',') : input.files;
    const fileList = await resolveFiles(filesInput, ctx, globRe);

    // Resolve the project root through realpath ONCE so the sandbox check
    // below compares like-for-like with realpath(file). The project root
    // itself can be a symlink or short name — e.g. macOS temp dirs live under
    // /var -> /private/var, and Windows CI runners expose an 8.3 short name
    // (C:\Users\RUNNER~1\...). Comparing realpath(file) against the raw root
    // then makes every legitimately-inside file look "outside" and skips it.
    const realRoot = await fs.realpath(ctx.projectRoot).catch(() => ctx.projectRoot);

    const fileResults = await mapWithConcurrency(fileList, 16, async (absPath) => {
      signal?.throwIfAborted();
      // Use lstat to detect symlinks. resolveFiles already applies
      // safeResolve, but a symlink with a target outside the project
      // root would still pass that string check — explicitly skip it
      // so we never read or write through a link.
      const lstat = await fs.lstat(absPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        /* v8 ignore next -- non-ENOENT lstat failure (EACCES etc.) is a defensive rethrow. */
        throw err;
      });
      if (!lstat?.isFile()) return null;
      if (lstat.isSymbolicLink()) return null;

      // Cross-check via realpath: if the resolved target lives outside the
      // project root (e.g. a bind mount or a parent-dir traversal we missed),
      // skip rather than rewrite through it.
      let realPath: string;
      try {
        realPath = await fs.realpath(absPath);
      } catch {
        /* v8 ignore next -- realpath failing after a successful lstat is a TOCTOU race; defensive. */
        return null;
      }
      const rel = path.relative(realRoot, realPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

      // Now stat the real target so we use its mode for atomicWrite.
      const stat = await fs.stat(realPath).catch(() => null);
      if (!stat?.isFile()) return null;

      let content: string;
      try {
        const buf = await fs.readFile(realPath);
        if (isBinaryBuffer(buf)) return null;
        content = buf.toString('utf8');
      } catch {
        /* v8 ignore next -- readFile failing after a successful stat is a TOCTOU race; defensive. */
        return null;
      }

      const style = detectNewlineStyle(content);
      const contentLf = normalizeToLf(content);
      re.lastIndex = 0;
      const allMatches = [...contentLf.matchAll(re)];
      if (allMatches.length === 0) return null;

      // When replace_all is false, only act on the first match.
      const matches = replaceAll ? allMatches : allMatches.slice(0, 1);
      const count = matches.length;

      // Rebuild: single forward pass through matches to avoid quadratic intermediate string allocations.
      let newContentLf = '';
      let lastIdx = 0;
      for (let i = 0; i < matches.length; i++) {
        const m = expectDefined(matches[i]);
        const matchIdx = expectDefined(m.index);
        newContentLf += contentLf.slice(lastIdx, matchIdx) + expandReplacement(input.replacement, m);
        lastIdx = matchIdx + m[0].length;
      }
      newContentLf += contentLf.slice(lastIdx);
      re.lastIndex = 0;

      if (!dryRun) {
        const newContent = toStyle(newContentLf, style);
        // Write to the real path (already validated inside project root)
        // so atomicWrite's temp-and-rename can't be redirected through a
        // freshly-planted symlink at absPath.
        await atomicWrite(realPath, newContent, { mode: stat.mode & 0o777 });
        // Same bookkeeping as `edit`: record the new mtime + hash (tagged
        // 'write' so the permission bypass does not widen) so a later `edit`
        // of this file doesn't trip the stale-read guard on our own write,
        // and record the change for session rewind. Optional calls: embedders
        // may hand in a duck-typed Context without these members.
        const written = await fs.stat(realPath).catch(() => null);
        if (written) {
          ctx.recordRead?.(realPath, written.mtimeMs, 'write', sha256hex(newContent));
        }
        ctx.session?.recordFileChange?.({
          path: realPath,
          action: 'modified',
          before: content,
          after: newContent,
        });
      }

      const rawDiff: string | undefined =
        dryRun || matches.length > 0
          ? unifiedDiff(content, toStyle(newContentLf, style), {
              fromFile: absPath,
              toFile: absPath,
            })
          : undefined;

      return {
        path: absPath,
        replacements: count,
        rawDiff,
      };
    });

    const results: ReplaceOutput['results'] = [];
    let totalReplacements = 0;
    // Combined diff budget across all files: once spent, later diffs are
    // omitted (the summary counters still report every file).
    let diffBytesUsed = 0;
    let diffsOmitted = 0;
    let diffsTruncated = 0;

    for (const item of fileResults) {
      if (!item) continue;
      totalReplacements += item.replacements;

      let diff = item.rawDiff;
      if (diff !== undefined) {
        const remaining = MAX_DIFF_BYTES - diffBytesUsed;
        if (remaining <= 0) {
          diff = undefined;
          diffsOmitted++;
        } else {
          const capped = truncateDiffPayload(diff, remaining);
          if (capped.truncated) diffsTruncated++;
          diff = capped.text;
          diffBytesUsed += Buffer.byteLength(diff, 'utf8');
        }
      }

      results.push({
        path: item.path,
        replacements: item.replacements,
        diff,
      });
    }

    if (!dryRun && results.length > 0) {
      try {
        enqueueReindex({
          projectRoot: ctx.projectRoot,
          files: results.map((r) => r.path),
        });
      } catch {
        // Non-fatal background reindex
      }
    }

    const overBudget = diffsOmitted > 0 || diffsTruncated > 0;
    return {
      files_modified: results.length,
      total_replacements: totalReplacements,
      results,
      dry_run: dryRun,
      note: overBudget
        ? `Diff payload exceeded the 256 KiB output budget: ${diffsTruncated} diff(s) truncated, ` +
          `${diffsOmitted} diff(s) omitted. Replacement counts are complete; use the read tool to inspect individual files.`
        : undefined,
    };
  },
};

/**
 * Expand a replacement template against one regex match with JavaScript
 * `String.prototype.replace` semantics: `$1`–`$9` insert capture groups
 * (empty when the group did not participate), `$&` inserts the whole match,
 * and `$$` inserts a literal `$`. A `$` followed by anything else — or a
 * digit that exceeds the pattern's group count — stays literal, mirroring
 * String.replace.
 */
function expandReplacement(template: string, match: RegExpMatchArray): string {
  if (!template.includes('$')) return template;
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch !== '$') {
      out += ch;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') {
      out += '$';
      i++;
    } else if (next === '&') {
      out += match[0];
      i++;
    } else if (next !== undefined && next >= '1' && next <= '9') {
      const idx = next.charCodeAt(0) - 48;
      if (idx < match.length) {
        out += match[idx] ?? '';
        i++;
      } else {
        // Group does not exist in the pattern: keep `$N` literal.
        out += '$';
      }
    } else {
      out += '$';
    }
  }
  return out;
}

/** True when `name` (basename), `rel` (relative to base), or `full` (path) passes the compiled extra glob. */
function passesExtraGlob(
  extraGlob: RegExp,
  name: string,
  full: string,
  base?: string,
): boolean {
  extraGlob.lastIndex = 0;
  if (extraGlob.test(name)) return true;
  if (base) {
    const rel = path.relative(base, full);
    const posixRel =
      !rel || rel.startsWith('..') || path.isAbsolute(rel)
        ? full.split(path.sep).join('/')
        : rel.split(path.sep).join('/');
    extraGlob.lastIndex = 0;
    if (extraGlob.test(posixRel)) return true;
  }
  const posixFull = full.split(path.sep).join('/');
  extraGlob.lastIndex = 0;
  if (extraGlob.test(posixFull)) return true;
  extraGlob.lastIndex = 0;
  return extraGlob.test(full);
}

async function resolveFiles(
  filesInput: string,
  ctx: Context,
  extraGlob?: RegExp | null | undefined,
): Promise<string[]> {
  const base = ctx.cwd;
  // Glob routing is per-entry so a comma list can mix literal paths and
  // globs. Any `*` or `?` marks the entry as a glob — a mid-path single-star
  // pattern like `src/*.ts` previously fell through to the literal branch,
  // where stat("src/*.ts") failed and the file was silently dropped (the
  // tool reported files_modified=0 for a documented "glob pattern" input).
  // `[`/`]` are deliberately NOT treated as glob syntax here: they are legal
  // in Windows filenames (C:\Users\Foo[1]\...), so a literal path containing
  // them must stay on the literal branch.
  const parts = filesInput
    .trim()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const resolved: string[] = [];

  for (const p of parts) {
    if (p.includes('*') || p.includes('?')) {
      resolved.push(...(await globFiles(p, base, extraGlob)));
      continue;
    }
    // `safeResolveReal`, not `safeResolve`: this list feeds a MUTATING tool, so
    // an in-root symlink pointing outside the project must not be rewritten
    // through. Matches what `edit`/`write` already do per file.
    const absPath = await safeResolveReal(p, ctx);
    // Honor the extra `glob` filter on explicitly-listed files too — a
    // comma-separated list combined with `glob: "*.ts"` must not rewrite
    // the non-.ts entries.
    if (extraGlob && !passesExtraGlob(extraGlob, path.basename(absPath), absPath, base)) continue;
    const stat = await fs.stat(absPath).catch(() => null);
    if (stat?.isFile()) {
      resolved.push(absPath);
    }
  }

  return resolved;
}

async function globFiles(
  pattern: string,
  base: string,
  extraGlob?: RegExp | null | undefined,
): Promise<string[]> {
  const rgAvailable = await checkRg();
  if (rgAvailable) {
    try {
      const { promise } = spawnRgFind(pattern, base);
      const files = await promise;
      // The extra `glob` filter was previously dropped on this path — only the
      // native fallback walker honored it. Apply it here as an intersection
      // (rg's own multi-`--glob` semantics are a union, so the narrowing must
      // happen on the enumerated list).
      if (extraGlob) {
        return files.filter((f) => passesExtraGlob(extraGlob, path.basename(f), f, base));
      }
      return files;
    } catch {
      // fall through
    }
  }

  return await globNative(pattern, base, extraGlob);
}

/**
 * Memoized rg availability probe. The binary does not appear or vanish
 * mid-process, so one `rg --version` spawn per process is enough — previously
 * every replace call paid a fresh probe spawn.
 */
let rgAvailabilityCache: Promise<boolean> | undefined;

/** Test-only: forget the cached rg availability so mocks can vary per test. */
export function __resetRgDetectionForTests(): void {
  rgAvailabilityCache = undefined;
}

function checkRg(): Promise<boolean> {
  rgAvailabilityCache ??= new Promise((resolve) => {
    try {
      const p = spawn('rg', ['--version'], {
        env: buildChildEnv(),
        stdio: 'ignore',
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

function spawnRgFind(pattern: string, base: string): { promise: Promise<string[]> } {
  // NOTE: the extra `glob` filter is deliberately NOT passed as a second
  // `--glob` here — rg treats multiple include globs as a union (match ANY),
  // which would broaden the set. The intersection happens in `globFiles` on
  // the enumerated list instead.
  const args = ['--files', '--glob', pattern, base];
  // 30-second safety net to prevent zombie rg processes. Unlike the main
  // grep tool, glob file enumeration is fast and should never need more time.
  const child = spawn('rg', args, {
    // Anchored globs (`src/*.ts`) are matched by rg against paths relative to
    // ITS cwd, not the search root. Without this the child inherits the
    // process cwd, so `files: "src/*.ts"` silently matches nothing whenever
    // the tool's base differs from the cwd of the host process and the native
    // walker never engages (the rg call resolves, just empty).
    cwd: base,
    signal: AbortSignal.timeout(30_000),
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Bound the capture like grep.ts and bash.ts already do. A pathological glob
  // over a huge tree could otherwise accumulate the whole file listing in one
  // unbounded string before it is ever split.
  const MAX_BUF_CHARS = 8 * 1024 * 1024;
  let buf = '';
  let truncated = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (truncated) return;
    buf += chunk.toString();
    if (buf.length > MAX_BUF_CHARS) {
      truncated = true;
      // Drop the partial trailing path so we never emit a half-written name.
      buf = buf.slice(0, buf.lastIndexOf('\n') + 1);
      child.kill();
    }
  });
  return {
    promise: new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => {
        resolve(
          buf
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      });
    }),
  };
}

async function globNative(
  pattern: string,
  base: string,
  extraGlob?: RegExp | null | undefined,
): Promise<string[]> {
  const results: string[] = [];
  const globRe = compileGlob(pattern);

  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      /* v8 ignore next -- unreadable directory during the walk; defensive. */
      return;
    }
    for (const e of entries) {
      if (DEFAULT_IGNORE.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      // Dirent.isSymbolicLink() uses readdir's d_type, which may not detect
      // directory symlinks on Windows (d_type = DT_UNKNOWN). Defensive stat
      // call: skip any entry whose lstat shows a symlink — file or directory.
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) continue;
      } catch {
        // lstat fails for very unusual entries (e.g. broken symlinks to deleted
        // files on NFS); skip safely rather than surfacing an error.
        /* v8 ignore next -- lstat failing on a readdir entry is a rare NFS/race case; defensive. */
        continue;
      }
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const name = e.name;
        // The walker compares compiled globs (anchored at the walk base, e.g.
        // `^src/[^/]*\.ts$`) against the basename and the ABSOLUTE `full`
        // path — a relative-anchored glob can never match an absolute path,
        // so `src/*.ts` silently matched nothing even when routed here. Test
        // the path relative to `base` as well (forward-slashed so the pattern
        // separators line up on Windows too).
        const rel = path.relative(base, full).split(path.sep).join('/');
        if (globRe.test(name) || globRe.test(rel) || globRe.test(full)) {
          if (extraGlob && !passesExtraGlob(extraGlob, name, full, base)) {
            continue;
          }
          results.push(full);
        }
        globRe.lastIndex = 0;
      }
    }
  };

  await walk(base);
  return results;
}
