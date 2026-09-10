/**
 * WS-SEC-ReDoS — differential suite for the gitignore matcher.
 *
 * `compileGitignore` used to build each rule by splicing the `compileGlob`
 * regex SOURCE into a larger regex (`(?:^|.*\/)` + body + `(?:\/.*)?$`). That
 * inherited the glob regex's catastrophic backtracking AND added a second
 * unbounded `.*` in front of it — so a single repo-committed `.gitignore` line
 * could wedge the indexer.
 *
 * The composition is now expressed as boundary predicates over a linear glob
 * NFA. This file keeps a verbatim copy of the OLD composed-regex matcher as
 * the oracle and asserts the two agree on every (rule set, path, isDir)
 * triple, then pins the ReDoS bound.
 */

import { describe, expect, it } from 'vitest';
import { compileGitignore } from '../src/codebase-index/gitignore.js';

// ---------------------------------------------------------------------------
// ORACLE: pre-fix gitignore.ts, including its own copy of the pre-fix
// compileGlob (so the oracle is genuinely the old behaviour end to end).
// ---------------------------------------------------------------------------

function oldEscapeRegex(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, '\\$&');
}

function oldCompileGlob(pattern: string): RegExp {
  if (pattern.length > 1024) throw new Error('Glob pattern exceeds 1024 characters');
  let i = 0;
  let re = '^';
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      const closeIndex = pattern.indexOf(']', i + 1);
      if (closeIndex === -1) {
        re += '\\[';
        i++;
        continue;
      }
      let cls = '[';
      i++;
      if (pattern[i] === '!' || pattern[i] === '^') {
        cls += '^';
        i++;
      }
      let firstMember = true;
      while (i < pattern.length && (pattern[i] !== ']' || firstMember)) {
        const ch = pattern[i] ?? '';
        if (ch === '\\') cls += '\\\\';
        else if (ch === ']' || ch === '^') cls += `\\${ch}`;
        else cls += ch;
        firstMember = false;
        i++;
      }
      cls += ']';
      re += cls;
      i++;
    } else {
      re += oldEscapeRegex(c ?? '');
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

function oldGlobBody(glob: string): string {
  return oldCompileGlob(glob).source.replace(/^\^/, '').replace(/\$$/, '');
}

type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean;

function oldCompileGitignore(lines: string[]): IgnoreMatcher {
  const rules: { eqOrUnder: RegExp; under: RegExp; negated: boolean; dirOnly: boolean }[] = [];
  for (const raw of lines) {
    let line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    line = line.trim();
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    const anchored = line.startsWith('/') || line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = oldGlobBody(line);
    const prefix = anchored ? '^' : '(?:^|.*/)';
    rules.push({
      eqOrUnder: new RegExp(`${prefix}${body}(?:/.*)?$`),
      under: new RegExp(`${prefix}${body}/.*$`),
      negated,
      dirOnly,
    });
  }
  const hasNegation = rules.some((r) => r.negated);
  return (relPath: string, isDir: boolean): boolean => {
    const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    let ignored = false;
    for (const r of rules) {
      const re = r.dirOnly && !isDir ? r.under : r.eqOrUnder;
      if (re.test(p)) {
        ignored = !r.negated;
        if (!hasNegation && ignored) return true;
      }
    }
    return ignored;
  };
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const LINES: string[] = [
  'node_modules',
  'node_modules/',
  '/node_modules',
  '/node_modules/',
  'dist',
  'dist/',
  '/dist/',
  '*.log',
  '*.log/',
  '**/*.log',
  '**/tmp',
  'tmp/**',
  'src/*.ts',
  'src/**/*.ts',
  'src/**/test/**/*.spec.ts',
  'build/output',
  '/build/output/',
  'a/b/c',
  'foo',
  'foo/',
  '!foo/keep.txt',
  '!*.log',
  '!dist/keep',
  '[abc].txt',
  'file[0-9].log',
  '[!x]*',
  '[]]',
  'weird[1.txt',
  '.env',
  '.env.*',
  'a?c',
  '?.ts',
  '*',
  '**',
  '**/',
  'a**b',
  'x/**/y',
  '  spaced  ',
  '# comment',
  '',
  '   ',
  'crlf\r',
  '!/anchored-negate',
  'deep/nested/dir/',
  'name.with.dots',
  'plus+sign',
  'paren(s)',
];

const PATHS: string[] = [
  '',
  'foo',
  'foo/',
  'foo/bar',
  'foo/bar/baz.ts',
  'foo/keep.txt',
  'barfoo',
  'barfoo/x',
  'a/foo',
  'a/foo/b',
  'a/barfoo',
  'node_modules',
  'node_modules/pkg',
  'node_modules/pkg/index.js',
  'pkg/node_modules/x',
  'anode_modules',
  'dist',
  'dist/main.js',
  'dist/keep',
  'nested/dist/main.js',
  'app.log',
  'logs/app.log',
  'app.log/inner',
  'src/a.ts',
  'src/a/b.ts',
  'src/a/test/b/c.spec.ts',
  'src/test/x.spec.ts',
  'srctest/x.spec.ts',
  'build/output',
  'build/output/x',
  'abuild/output',
  'a/b/c',
  'a/b/c/d',
  'xa/b/c',
  'a.txt',
  'd.txt',
  'file7.log',
  'fileA.log',
  ']',
  'weird[1.txt',
  '.env',
  '.env.local',
  'abc',
  'a/c',
  'x/y',
  'x/m/n/y',
  'xy',
  'tmp',
  'tmp/a',
  'deep/nested/dir',
  'deep/nested/dir/f.ts',
  'spaced',
  'crlf',
  'anchored-negate',
  'name.with.dots',
  'plus+sign',
  'paren(s)',
  './foo',
  '/foo',
  'a\\b',
];

/** Deterministic subsets of the rule list, so negation interactions are covered. */
function ruleSets(): string[][] {
  const sets: string[][] = [LINES];
  for (const line of LINES) sets.push([line]);
  // A few multi-rule combinations including negations (last match wins).
  sets.push(['node_modules', '!node_modules/keep']);
  sets.push(['*.log', '!important.log']);
  sets.push(['dist/', '!dist/keep']);
  sets.push(['foo', '!foo', 'foo']);
  sets.push(['**/*.log', '!logs/**']);
  sets.push(['/build/output/', 'dist', '*.log', '!dist/keep']);
  return sets;
}

describe('gitignore differential: boundary-predicate matcher vs. old composed regex', () => {
  it('agrees with the old implementation on every (rules, path, isDir) triple', () => {
    const disagreements: string[] = [];
    let cases = 0;

    for (const lines of ruleSets()) {
      let oracle: IgnoreMatcher;
      try {
        oracle = oldCompileGitignore(lines);
      } catch {
        continue;
      }
      const actual = compileGitignore(lines);
      for (const p of PATHS) {
        for (const isDir of [false, true]) {
          cases++;
          const want = oracle(p, isDir);
          const got = actual(p, isDir);
          if (got !== want) {
            disagreements.push(
              `rules=${JSON.stringify(lines)} path=${JSON.stringify(p)} isDir=${isDir}: old=${want} new=${got}`,
            );
          }
        }
      }
    }

    expect(cases).toBeGreaterThan(6000);
    expect(disagreements.slice(0, 15)).toEqual([]);
  });

  it('keeps the documented semantics that make the composition non-trivial', () => {
    // A bare name matches at any DEPTH, but must still align to a path
    // segment — this is why the anchor prefix cannot be spelled as `**/`,
    // which compiles to `.*` and would also swallow `barfoo`.
    const m = compileGitignore(['foo']);
    expect(m('foo', false)).toBe(true);
    expect(m('a/foo', false)).toBe(true);
    expect(m('a/b/foo', false)).toBe(true);
    expect(m('foo/bar', false)).toBe(true);
    expect(m('barfoo', false)).toBe(false);
    expect(m('foobar', false)).toBe(false);
    expect(m('a/barfoo', false)).toBe(false);

    // A slash anywhere anchors to the gitignore's directory.
    const anchored = compileGitignore(['build/output']);
    expect(anchored('build/output', false)).toBe(true);
    expect(anchored('build/output/x', false)).toBe(true);
    expect(anchored('a/build/output', false)).toBe(false);

    // dir-only rules never match a file by its own name.
    const dirOnly = compileGitignore(['dist/']);
    expect(dirOnly('dist', true)).toBe(true);
    expect(dirOnly('dist', false)).toBe(false);
    expect(dirOnly('dist/main.js', false)).toBe(true);
  });
});

describe('gitignore ReDoS regression (WS-SEC-ReDoS)', () => {
  it('a hostile .gitignore line no longer wedges the matcher', () => {
    // Before the fix this line's composed regex (`(?:^|.*/)` + 8 wildcards)
    // took tens of seconds against a short non-matching path, uninterruptibly.
    const hostile = ['**a'.repeat(8), '*a'.repeat(8), `${'*a'.repeat(6)}/x`];
    const m = compileGitignore(hostile);
    const path = `${'a'.repeat(255)}X`;
    m('warmup', false);
    const t0 = performance.now();
    const result = m(path, false);
    const ms = performance.now() - t0;
    expect(result).toBe(false);
    expect(ms).toBeLessThan(100);
  });

  it('stays fast on a deep path where every segment is a candidate start', () => {
    // The unanchored prefix means the body may start after ANY slash. All
    // candidate starts are explored inside one linear pass, so depth must not
    // multiply the cost.
    const m = compileGitignore(['*a*a*a*a*a']);
    const deep = `${`${'a'.repeat(30)}/`.repeat(40)}X`;
    m('warmup', false);
    const t0 = performance.now();
    m(deep, false);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(100);
  });
});
