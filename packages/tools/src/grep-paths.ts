import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolValidationError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { expandBraceAlternation } from './_glob-braces.js';
import { safeResolveReal } from './_util.js';
import { DEFAULT_IGNORE } from './grep-types.js';

/**
 * Shell-style `path` input for grep: `packages/{runtime,cli}/src`,
 * `packages/*\/src`. Models write these the way they would in a shell, and a
 * literal lookup answered `path "…" does not exist` — a dead end for what is
 * a perfectly clear scope. The tool now expands the path into concrete search
 * roots and searches each one.
 *
 * A literal path that exists always wins: `{` `}` `*` `?` `[` are legal in file
 * names. Only comma-bearing brace groups alternate (same rule as `glob`), and
 * `*` / `?` / `[…]` match within ONE segment — `**` is refused with a pointer
 * to the `glob` argument, which is the depth-aware filter.
 */
const MAX_SEARCH_ROOTS = 64;
const WILDCARD = /[*?[]/;

export function hasPathPattern(p: string): boolean {
  return WILDCARD.test(p) || expandBraceAlternation(p, 2).length > 1;
}

function segmentMatcher(segment: string): RegExp {
  let src = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (c === '*') src += '[^/\\\\]*';
    else if (c === '?') src += '[^/\\\\]';
    else if (c === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) {
        src += '\\[';
        continue;
      }
      let body = segment.slice(i + 1, close);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      src += `[${body.replace(/\\/g, '\\\\')}]`;
      i = close;
    } else src += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, process.platform === 'win32' ? 'i' : '');
}

async function isInside(candidate: string, ctx: Context): Promise<boolean> {
  return await safeResolveReal(candidate, ctx).then(
    () => true,
    () => false,
  );
}

/** Expand one brace-free candidate's wildcard segments against the disk. */
async function expandWildcards(candidate: string, ctx: Context, budget: number): Promise<string[]> {
  const segments = candidate.split(/[\\/]+/);
  if (segments.some((s) => s === '**')) {
    throw new ToolValidationError({
      message:
        'grep: `**` is not supported in `path`; pass the base directory as `path` and the recursive pattern as `glob` (e.g. path: "packages", glob: "**/src/**/*.ts")',
      field: 'path',
      context: { contract: false },
    });
  }
  let prefixes: string[] = [path.isAbsolute(candidate) ? '' : '.'];
  const absolute = path.isAbsolute(candidate);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    if (segment === '' && i === 0 && absolute) {
      prefixes = [path.parse(candidate).root];
      continue;
    }
    if (segment === '' || segment === '.') continue;
    if (!WILDCARD.test(segment)) {
      prefixes = prefixes.map((p) => (p ? path.join(p, segment) : segment));
      continue;
    }
    const matcher = segmentMatcher(segment);
    const next: string[] = [];
    for (const prefix of prefixes) {
      const dir = path.resolve(ctx.cwd, prefix || '.');
      if (!(await isInside(dir, ctx))) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!matcher.test(entry.name)) continue;
        // A wildcard must not pull build output / VCS dirs back into scope.
        if (entry.isDirectory() && DEFAULT_IGNORE.has(entry.name)) continue;
        // Leading-dot entries only match a segment that spells the dot.
        if (entry.name.startsWith('.') && !segment.startsWith('.')) continue;
        next.push(prefix ? path.join(prefix, entry.name) : entry.name);
        if (next.length >= budget) break;
      }
      if (next.length >= budget) break;
    }
    prefixes = next;
    if (prefixes.length === 0) break;
  }
  return prefixes;
}

/**
 * Concrete search roots for `rawPath`, or `undefined` when the path needs no
 * expansion (no pattern syntax, or the literal path exists). Throws a
 * validation error naming the expansions when none of them exists.
 */
export async function expandGrepPath(rawPath: string, ctx: Context): Promise<string[] | undefined> {
  if (!hasPathPattern(rawPath)) return undefined;
  const literal = path.resolve(ctx.cwd, rawPath);
  if (await fs.stat(literal).catch(() => null)) return undefined;

  const roots: string[] = [];
  const seen = new Set<string>();
  const candidates = expandBraceAlternation(rawPath, MAX_SEARCH_ROOTS);
  for (const candidate of candidates) {
    const expanded = WILDCARD.test(candidate)
      ? await expandWildcards(candidate, ctx, MAX_SEARCH_ROOTS - roots.length)
      : [candidate];
    for (const item of expanded) {
      const key = path.resolve(ctx.cwd, item);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(await fs.stat(key).catch(() => null))) continue;
      roots.push(item.split(path.sep).join('/'));
      if (roots.length >= MAX_SEARCH_ROOTS) return roots;
    }
  }
  if (roots.length === 0) {
    const shown = candidates.slice(0, 8).join(', ');
    throw new ToolValidationError({
      message: `grep: path "${rawPath}" matched no existing file or directory (tried: ${shown}${candidates.length > 8 ? ', …' : ''})`,
      field: 'path',
      context: { contract: false },
    });
  }
  return roots;
}
