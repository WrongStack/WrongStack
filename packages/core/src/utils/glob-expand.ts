import { expectDefined } from './expect-defined.js';
/**
 * Glob pattern → concrete file path expansion.
 *
 * Supports: *, **, ?, [...]
 * Does NOT support brace expansion {a,b}.
 *
 * Returns the input as-is if it contains no glob metacharacters.
 * On Windows, both / and \ are accepted as path separators.
 */

import * as fsp from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const GLOB_CHARS = new Set(['*', '?', '[']);
const IS_WINDOWS = typeof process !== 'undefined' && process.platform === 'win32';
const SEP = IS_WINDOWS ? '\\' : '/';

function isGlob(p: string): boolean {
  for (const c of p) {
    if (GLOB_CHARS.has(c)) return true;
  }
  return false;
}

function globToRegex(pat: string): RegExp {
  let i = 0;
  let re = '^';
  while (i < pat.length) {
    const c = expectDefined(pat[i]);
    if (c === '*') {
      if (pat[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pat[i] === '/') i++;
      } else {
        re += '[^/\\\\]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/\\\\]';
      i++;
    } else if (c === '[') {
      let closeSearchStart = i + 1;
      if (pat[closeSearchStart] === '!' || pat[closeSearchStart] === '^') {
        closeSearchStart++;
      }
      if (pat[closeSearchStart] === ']') {
        closeSearchStart++;
      }
      const closeIndex = pat.indexOf(']', closeSearchStart);
      if (closeIndex === -1) {
        re += '\\[';
        i++;
        continue;
      }
      let cls = '[';
      i++;
      if (pat[i] === '!' || pat[i] === '^') {
        cls += '^';
        i++;
      }
      // Same literal-`]`-as-first-member rule as `compileGlob` in
      // glob-match.ts: `[]]` is class { ']' }, not an empty class. The
      // `ch === ']'` branch was previously dead code because the loop closed
      // on the first `]`; `first` is cleared after the first iteration so
      // any later `]` still terminates the class.
      let first = true;
      while (i < pat.length && (pat[i] !== ']' || first)) {
        const ch = pat[i] ?? '';
        if (ch === '\\') cls += '\\\\';
        else if (ch === ']' || ch === '^') cls += `\\${ch}`;
        else cls += ch;
        first = false;
        i++;
      }
      cls += ']';
      re += cls;
      i++;
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(re + '$');
}

function baseDir(pat: string): string {
  // Deepest literal directory prefix: cut at the last separator BEFORE the
  // first glob char. Scanning from the end instead finds separators inside
  // glob segments — '**/*.ts' would yield base '**' on POSIX (native sep '/').
  let firstGlob = pat.length;
  for (let i = 0; i < pat.length; i++) {
    if (GLOB_CHARS.has(expectDefined(pat[i]))) {
      firstGlob = i;
      break;
    }
  }
  const cut = Math.max(pat.lastIndexOf(SEP, firstGlob - 1), pat.lastIndexOf('/', firstGlob - 1));
  if (cut < 0) return '.';
  if (cut === 0) return pat[0] ?? '/';
  // A bare `D:` is drive-RELATIVE (the cwd on that drive), not the root the
  // pattern `D:\*` names: keep the root separator.
  if (cut === 2 && /^[A-Za-z]:$/.test(pat.slice(0, 2))) return pat.slice(0, 3);
  return pat.slice(0, cut);
}

/**
 * Resolve `pattern` to the set of concrete file paths it matches.
 * Literal paths (no glob chars) are returned as-is.
 *
 * @example
 * await expandGlob('src/**\/*.ts')  // → ['src/a.ts', 'src/b/c.ts', ...]
 * await expandGlob('foo.txt')       // → ['foo.txt']
 */
export async function expandGlob(pattern: string): Promise<string[]> {
  if (typeof pattern !== 'string') return [];
  if (!isGlob(pattern)) return [pattern];

  const normalized = pattern.replace(/\\/g, '/');
  const results = new Set<string>();
  const abs = isAbsolute(pattern);
  const base = baseDir(pattern);
  const baseNorm = base.replace(/\\/g, '/');
  const relPat =
    base === '.'
      ? // A leading `./` is shell noise, not a directory segment: walk() matches
        // literal segments against readdir entries and readdir never yields `.`,
        // so the prefix must not reach the segment matcher — `./*.ts` must
        // expand exactly like `*.ts`. `.\` forms arrive here already
        // slash-normalized.
        normalized.replace(/^(?:\.\/)+/u, '')
      : normalized.slice(baseNorm.length + (baseNorm.endsWith('/') ? 0 : 1));

  async function walk(dir: string, pat: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (pat.startsWith('**/')) {
      const rest = pat.slice(3);
      // Try matching files in the current dir with the pattern after **/
      await walk(dir, rest);
      // Recurse into all subdirectories with the same **/ pattern
      for (const e of entries) {
        if (e.isDirectory()) {
          const subDir = `${dir}${SEP}${e.name}`;
          await walk(subDir, pat);
        }
      }
      return;
    }

    if (pat === '**') {
      for (const e of entries) {
        const full = `${dir}${SEP}${e.name}`;
        // Directories are traversed, never returned: this resolves a pattern to
        // FILE paths (see the module docblock). Returning them made callers
        // that count the result as files over-count — `collab_debug` refused a
        // target with 3 files as "5 files, which exceeds the limit".
        if (!e.isDirectory()) results.add(abs ? resolve(full) : full);
        if (e.isDirectory()) {
          await walk(full, '**');
        }
      }
      return;
    }

    const firstSlash = pat.indexOf('/');
    if (firstSlash < 0) {
      // Leaf segment (e.g. *.ts or ?.js)
      const re = globToRegex(pat);
      for (const e of entries) {
        // File paths only — a directory whose NAME matches the leaf pattern
        // (src/* matching src/deep) is traversed by the caller's own walk,
        // not returned as a match.
        if (!e.isDirectory() && re.test(e.name)) {
          const full = `${dir}${SEP}${e.name}`;
          results.add(abs ? resolve(full) : full);
        }
      }
      return;
    }

    const currentSeg = pat.slice(0, firstSlash);
    const remainingPat = pat.slice(firstSlash + 1);

    if (isGlob(currentSeg)) {
      const re = globToRegex(currentSeg);
      for (const e of entries) {
        if (e.isDirectory() && re.test(e.name)) {
          const subDir = `${dir}${SEP}${e.name}`;
          await walk(subDir, remainingPat);
        }
      }
    } else {
      for (const e of entries) {
        if (e.isDirectory() && e.name === currentSeg) {
          const subDir = `${dir}${SEP}${e.name}`;
          await walk(subDir, remainingPat);
        }
      }
    }
  }

  await walk(base === '.' ? '.' : base, relPat);
  // `[` and `?` are legal in file names (`app/[id]/page.tsx`): like a shell,
  // a pattern that matched nothing but names an existing path is that path.
  if (results.size === 0 && (await fsp.lstat(pattern).catch(() => null))) return [pattern];
  return [...results];
}
