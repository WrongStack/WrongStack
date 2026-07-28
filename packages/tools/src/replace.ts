import { expectDefined } from '@wrongstack/core/utils';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  atomicWrite,
  buildChildEnv,
  compileGlob,
  detectNewlineStyle,
  normalizeToLf,
  toStyle,
  unifiedDiff,
} from '@wrongstack/core/utils';
import { ToolValidationError } from '@wrongstack/core/types';
import type { Context } from '@wrongstack/core/agent';
import type { Tool } from '@wrongstack/core/types';
import { compileUserRegex } from './_regex.js';
import { isBinaryBuffer, safeResolve, sha256hex } from './_util.js';
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
    'This tool is excellent for large-scale refactors (renaming, import updates, etc.) but must be used with caution.',
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'edit',
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to match' },
      replacement: { type: 'string', description: 'Replacement string' },
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
  async execute(input: ReplaceInput, ctx: Context) {
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

    const results: ReplaceOutput['results'] = [];
    let totalReplacements = 0;

    for (const absPath of fileList) {
      // Use lstat to detect symlinks. resolveFiles already applies
      // safeResolve, but a symlink with a target outside the project
      // root would still pass that string check — explicitly skip it
      // so we never read or write through a link.
      const lstat = await fs.lstat(absPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        /* v8 ignore next -- non-ENOENT lstat failure (EACCES etc.) is a defensive rethrow. */
        throw err;
      });
      if (!lstat?.isFile()) continue;
      if (lstat.isSymbolicLink()) continue;

      // Cross-check via realpath: if the resolved target lives outside the
      // project root (e.g. a bind mount or a parent-dir traversal we missed),
      // skip rather than rewrite through it.
      let realPath: string;
      try {
        realPath = await fs.realpath(absPath);
      } catch {
        /* v8 ignore next -- realpath failing after a successful lstat is a TOCTOU race; defensive. */
        continue;
      }
      const rel = path.relative(realRoot, realPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

      // Now stat the real target so we use its mode for atomicWrite.
      const stat = await fs.stat(realPath).catch(() => null);
      if (!stat?.isFile()) continue;

      let content: string;
      try {
        const buf = await fs.readFile(realPath);
        if (isBinaryBuffer(buf)) continue;
        content = buf.toString('utf8');
      } catch {
        /* v8 ignore next -- readFile failing after a successful stat is a TOCTOU race; defensive. */
        continue;
      }

      const style = detectNewlineStyle(content);
      const contentLf = normalizeToLf(content);
      re.lastIndex = 0;
      const allMatches = [...contentLf.matchAll(re)];
      if (allMatches.length === 0) continue;

      // When replace_all is false, only act on the first match.
      const matches = replaceAll ? allMatches : allMatches.slice(0, 1);
      const count = matches.length;

      // Rebuild: splice the replacement into each match position from
      // right to left so earlier indices stay valid.
      let newContentLf = contentLf;
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = expectDefined(matches[i]);
        newContentLf =
          newContentLf.slice(0, m.index) +
          input.replacement +
          newContentLf.slice(expectDefined(m.index) + m[0].length);
      }
      re.lastIndex = 0;
      totalReplacements += count;

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

      const diff =
        dryRun || matches.length > 0
          ? unifiedDiff(content, toStyle(newContentLf, style), {
              fromFile: absPath,
              toFile: absPath,
            })
          : undefined;

      results.push({
        path: absPath,
        replacements: matches.length,
        diff,
      });
    }

    return {
      files_modified: results.length,
      total_replacements: totalReplacements,
      results,
      dry_run: dryRun,
    };
  },
};

async function resolveFiles(
  filesInput: string,
  ctx: Context,
  extraGlob?: RegExp | null | undefined,
): Promise<string[]> {
  const base = ctx.cwd;
  const normalized = filesInput.trim();

  if (normalized.startsWith('**/') || normalized.startsWith('*') || normalized.includes('**')) {
    return await globFiles(normalized, base, extraGlob);
  }

  const parts = normalized
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const resolved: string[] = [];

  for (const p of parts) {
    const absPath = safeResolve(p, ctx);
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
      return await promise;
    } catch {
      // fall through
    }
  }

  return await globNative(pattern, base, extraGlob);
}

function checkRg(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn('rg', ['--version'], { env: buildChildEnv(), stdio: 'ignore', windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function spawnRgFind(pattern: string, base: string): { promise: Promise<string[]> } {
  const args = ['--files', '--glob', pattern, base];
  // 30-second safety net to prevent zombie rg processes. Unlike the main
  // grep tool, glob file enumeration is fast and should never need more time.
  const child = spawn('rg', args, {
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
        resolve(buf.split('\n').filter(Boolean));
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
        if (globRe.test(name) || globRe.test(full)) {
          if (extraGlob && !extraGlob.test(name) && !extraGlob.test(full)) continue;
          results.push(full);
        }
        globRe.lastIndex = 0;
        if (extraGlob) extraGlob.lastIndex = 0;
      }
    }
  };

  await walk(base);
  return results;
}
