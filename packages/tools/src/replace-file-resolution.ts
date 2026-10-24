import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ToolValidationError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { buildChildEnv, compilePathGlob } from '@wrongstack/core/utils';
import { mapWithConcurrency } from './_concurrency.js';
import { safeResolveReal } from './_util.js';
import { loadGitignoreMatcher } from './codebase-index/gitignore.js';

const DEFAULT_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

/** True when `name` (basename), `rel` (relative to base), or `full` (path) passes the compiled extra glob. */
function passesExtraGlob(extraGlob: RegExp, name: string, full: string, base?: string): boolean {
  extraGlob.lastIndex = 0;
  if (extraGlob.test(name)) return true;
  if (base) {
    const rel = path.relative(base, full);
    const posixRel =
      !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
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

/**
 * True when a path under `base` has a path segment the walker never descends
 * into (`DEFAULT_IGNORE`). `globNative` drops such entries as it walks; the rg
 * fast path has no notion of them — ripgrep only knows `.gitignore` — so its
 * list has to pass the same rule or an un-gitignored `node_modules`/`dist`/
 * `build` is rewritten on machines that have ripgrep and skipped on machines
 * that do not. A path outside `base` is left to the callers' containment
 * checks (this function only reports, it does not reject).
 */
function hasIgnoredSegment(absPath: string, base: string): boolean {
  const rel = path.relative(base, absPath);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).some((segment) => DEFAULT_IGNORE.has(segment));
}

/**
 * Split a `files` string into entries on commas that are NOT inside a `{…}`
 * brace group.
 *
 * The list is comma-separated and each entry may be a glob, but a
 * brace-alternation glob (`*.{ts,md}`) contains the list separator itself. A
 * naive split tore it into `*.{ts` and `md}`; the second half has no glob
 * character, so it took the literal-path branch and the whole call failed with
 * `replace: file not found "md}"` — while the very same pattern passed as a
 * one-element array worked. Entries cannot express a literal comma (the list
 * syntax has no escape); a brace group keeps its commas.
 */
function splitFileList(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '{') depth++;
    else if (ch === '}' && depth > 0) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

export async function resolveFiles(
  filesInput: string | string[],
  ctx: Context,
  extraGlob?: RegExp | null | undefined,
): Promise<string[]> {
  const base = ctx.workingDir ?? ctx.cwd;
  // Glob routing is per-entry so a comma list can mix literal paths and
  // globs. Any `*` or `?` marks the entry as a glob — a mid-path single-star
  // pattern like `src/*.ts` previously fell through to the literal branch,
  // where stat("src/*.ts") failed and the file was silently dropped (the
  // tool reported files_modified=0 for a documented "glob pattern" input).
  // `[`/`]` are deliberately NOT treated as glob syntax here: they are legal
  // in Windows filenames (C:\Users\Foo[1]\...), so a literal path containing
  // them must stay on the literal branch.
  const parts = Array.isArray(filesInput)
    ? filesInput
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
    : splitFileList(filesInput.trim());
  const resolved: string[] = [];

  for (const p of parts) {
    if (p.includes('*') || p.includes('?') || RIPGREP_ONLY_GLOB.test(p)) {
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
      continue;
    }
    // A literally named file that does not exist at all is a bad input, not
    // "0 replacements": silently dropping it reads as a successful no-op.
    // (A dangling symlink still exists via lstat and stays a silent skip.)
    if (!stat && !(await fs.lstat(absPath).catch(() => null))) {
      throw new ToolValidationError({
        message: `replace: file not found "${p}"`,
        field: 'files',
      });
    }
  }

  return [...new Set(resolved)];
}

/** True when a `{` in the pattern is never closed — invalid in every dialect. */
function hasUnclosedBrace(pattern: string): boolean {
  let depth = 0;
  for (const ch of pattern) {
    if (ch === '{') depth++;
    else if (ch === '}' && depth > 0) depth--;
  }
  return depth > 0;
}

/** Brace ALTERNATION (`*.{ts,md}`) or a leading `!` exclude — ripgrep dialect. */
const RIPGREP_ONLY_GLOB = /\{[^}]*,[^}]*\}|^!/;

/**
 * Refuse a `files` glob that would silently enumerate nothing instead of
 * running. Two shapes did, both reported as a successful `files_modified: 0`:
 *
 * - An unclosed `{`: invalid in every dialect (ripgrep reports "unclosed
 *   alternate group" and exits 2, which the caller swallows and answers with a
 *   native walk), so it is refused whatever the enumerator is.
 * - Brace ALTERNATION and a leading `!`: constructs only ripgrep's dialect
 *   expresses. core's `compilePathGlob` treats both as literal characters, so
 *   they are refused only when ripgrep is unavailable — i.e. when the pattern
 *   would fall to the walker that cannot expand it.
 *
 * A `{`/`}` group without a comma, with no leading `!`, stays legal: both
 * characters are valid in file names (the same care the glob router takes with
 * `[`/`]` and Windows names).
 */
function assertUsableFilesGlob(pattern: string, ripgrepAvailable: boolean): void {
  if (hasUnclosedBrace(pattern)) {
    throw new ToolValidationError({
      message: `replace: files "${pattern}" is not a valid glob — a "{" is never closed.`,
      field: 'files',
      context: { reason: 'unclosed-brace' },
    });
  }
  if (ripgrepAvailable || !RIPGREP_ONLY_GLOB.test(pattern)) return;
  throw new ToolValidationError({
    message:
      `replace: files "${pattern}" uses ${
        pattern.includes('{') ? 'brace alternation ({a,b})' : 'a leading "!" exclude'
      }, which only ripgrep can expand and the built-in walker cannot. ` +
      'Pass one pattern per entry instead (e.g. files: "*.ts,*.tsx"), or install ripgrep.',
    field: 'files',
    context: { reason: 'unsupported-glob' },
  });
}

/**
 * Same check for the extra `glob` filter (`passesExtraGlob`). That filter is
 * ALWAYS compiled by core's matcher — ripgrep never sees it — so its
 * ripgrep-only constructs are unexpressible on every machine: they matched no
 * file, narrowing every entry away, and the call reported `files_modified: 0`
 * as success. Unlike `files`, no amount of installing ripgrep helps here, so
 * the refusal is unconditional and says so.
 */
export function assertUsableGlobFilter(pattern: string): void {
  if (hasUnclosedBrace(pattern)) {
    throw new ToolValidationError({
      message: `replace: glob "${pattern}" is not a valid glob — a "{" is never closed.`,
      field: 'glob',
      context: { reason: 'unclosed-brace' },
    });
  }
  if (!RIPGREP_ONLY_GLOB.test(pattern)) return;
  throw new ToolValidationError({
    message:
      `replace: glob "${pattern}" uses ${
        pattern.includes('{') ? 'brace alternation ({a,b})' : 'a leading "!" exclude'
      }, which the built-in matcher cannot expand (this filter is never evaluated by ` +
      'ripgrep). Narrow with a pattern it can express instead, e.g. one extension per call.',
    field: 'glob',
    context: { reason: 'unsupported-glob' },
  });
}

async function globFiles(
  pattern: string,
  base: string,
  extraGlob?: RegExp | null | undefined,
): Promise<string[]> {
  const rgAvailable = await checkRg();
  assertUsableFilesGlob(pattern, rgAvailable);
  if (rgAvailable) {
    try {
      const { promise } = spawnRgFind(pattern, base);
      // Ripgrep knows `.gitignore` but nothing about the walker's static
      // DEFAULT_IGNORE list, so an un-gitignored node_modules/dist/build came
      // back from here and was rewritten, while the fallback walker skips it —
      // the same call touching different files depending on the environment,
      // in the destructive direction. Same segment rule as `globNative`.
      const files = (await promise).filter((f) => !hasIgnoredSegment(f, base));
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

/**
 * True when ripgrep can be expected to evaluate `pattern` at all.
 *
 * rg matches globs against '/'-separated paths relative to its cwd, so a
 * pattern that is absolute, carries a backslash, or starts with `./` can never
 * match. Measured (`rg --files --glob <shape>`): all three exit 1 with no
 * output, while the native walker is the one that answers them on the platforms
 * where they are meaningful — so for those shapes an empty rg answer carries no
 * information and the caller must keep its fallback. For every other shape, an
 * exit-1 answer means "no files matched" and no second walk is needed.
 */
function rgCanEvaluateGlob(pattern: string): boolean {
  if (path.isAbsolute(pattern)) return false;
  if (pattern.includes('\\')) return false;
  return !pattern.startsWith('./');
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
  // Decoder, not `chunk.toString()`: a path containing a non-ASCII character
  // split across a pipe chunk boundary would otherwise be enumerated with
  // U+FFFD in it, and the replace would miss (or mis-target) the file.
  const stdoutDecoder = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer) => {
    if (truncated) return;
    buf += stdoutDecoder.write(chunk);
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
      child.on('close', (code) => {
        // `rg --files` exits 1 when the glob matched no files — a successful
        // enumeration of an empty set, not a failure. Rejecting it threw that
        // answer away and re-walked the whole tree with the native walker
        // (measured: ~80 ms of pure waste per zero-match glob on an 8k-file
        // tree, on top of the rg walk that already answered). Patterns rg
        // cannot evaluate keep the fallback — see rgCanEvaluateGlob.
        const emptyResult = code === 1 && rgCanEvaluateGlob(pattern);
        if (code !== 0 && code !== null && !emptyResult) {
          reject(new Error(`rg exited with code ${code}`));
          return;
        }
        // Flush the decoder tail. When the buffer was capped the trailing
        // partial line was already dropped, so there is nothing to append.
        if (!truncated) buf += stdoutDecoder.end();
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
  const globRe = compilePathGlob(pattern);
  // The rg fast path enumerates with ripgrep, which never lists `.gitignore`d
  // files. The fallback walker must apply the same filter or the file set of a
  // single `files` glob changes with whether ripgrep happens to be installed —
  // and, on the fallback side, deliberately ignored paths get rewritten. Same
  // reasoning (and the same matcher) as glob.ts.
  const isGitIgnored = await loadGitignoreMatcher(base);

  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      /* v8 ignore next -- unreadable directory during the walk; defensive. */
      return;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      if (DEFAULT_IGNORE.has(e.name)) continue;
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
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (isGitIgnored(rel, true)) continue;
        subdirs.push(full);
      } else if (e.isFile()) {
        const name = e.name;
        if (isGitIgnored(rel, false)) continue;
        // The walker compares compiled globs (anchored at the walk base, e.g.
        // `^src/[^/]*\.ts$`) against the basename and the ABSOLUTE `full`
        // path — a relative-anchored glob can never match an absolute path,
        // so `src/*.ts` silently matched nothing even when routed here. Test
        // the path relative to `base` as well (forward-slashed so the pattern
        // separators line up on Windows too).
        if (globRe.test(name) || globRe.test(rel) || globRe.test(full)) {
          if (extraGlob && !passesExtraGlob(extraGlob, name, full, base)) {
            continue;
          }
          results.push(full);
        }
        globRe.lastIndex = 0;
      }
    }
    if (subdirs.length > 0) {
      await mapWithConcurrency(subdirs, 16, (subdir) => walk(subdir));
    }
  };

  await walk(base);
  return results;
}
