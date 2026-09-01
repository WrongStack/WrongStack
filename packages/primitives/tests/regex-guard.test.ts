/**
 * Regression tests for `compileUserRegex` and `capSubject`.
 *
 * This is the ReDoS gate for every user/LLM-supplied pattern in the repo
 * (grep, logs, replace, json, kanban file-matches all funnel through it). A
 * regression that lets `(a|a)*`-style patterns through pins a worker for
 * seconds, uninterruptibly — so each rejection class below is load-bearing.
 */

import { describe, expect, it } from 'vitest';
import { capSubject, compileUserRegex, MAX_SUBJECT_LEN } from '../src/regex-guard.js';

describe('compileUserRegex — accepted patterns', () => {
  it('compiles a plain pattern and preserves its flags', () => {
    const result = compileUserRegex('foo.bar', 'iu');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.regex).toBeInstanceOf(RegExp);
      expect(result.regex.flags).toContain('i');
      expect(result.regex.flags).toContain('u');
      expect(result.regex.test('FOO bar')).toBe(true);
    }
  });

  it('allows disjoint alternations with a quantifier', () => {
    const result = compileUserRegex('(foo|bar)+', '');
    expect(result.ok).toBe(true);
    // Named-group spellings of the same disjoint shape stay allowed too —
    // the named-group strip fix must reject ambiguity, not named groups.
    expect(compileUserRegex('(?<g>foo|bar)+', '').ok).toBe(true);
    expect(compileUserRegex('(?<g>a|a)', '').ok).toBe(true); // unquantified
  });

  it('allows disjoint groups nested under a quantifier', () => {
    // The round-12 recursion must reject ambiguity, not nesting itself:
    // disjoint nested branches and unquantified wrappers stay allowed.
    expect(compileUserRegex('(x(y|z))+', '').ok).toBe(true);
    expect(compileUserRegex('(x(a|b))+', '').ok).toBe(true);
    expect(compileUserRegex('((a|a))', '').ok).toBe(true); // no quantifier — linear
  });

  it('allows non-intersecting single-token branches', () => {
    // Round 13 char-set comparison must not over-block: a 1-char branch can
    // never equal a 2+-char branch, complements and disjoint classes do not
    // intersect, first-char overlap with distinct full strings is safe, and
    // the dot-with-newline idiom stays legal because `.` excludes \n
    // without the dotAll flag.
    expect(compileUserRegex(String.raw`(\w|ab)+`, '').ok).toBe(true);
    expect(compileUserRegex('(x|[^x])+', '').ok).toBe(true);
    expect(compileUserRegex(String.raw`(\d|a)+`, '').ok).toBe(true);
    expect(compileUserRegex(String.raw`(.|\n)+`, '').ok).toBe(true);
    expect(compileUserRegex('(ab|ac)+', '').ok).toBe(true);
  });

  it('allows multi-token branches with no common string', () => {
    // Round 14 soundness pins: a single disjoint position (`\d` ∩ {b} = ∅)
    // or a length mismatch (2 vs 3) proves the branch languages cannot
    // intersect, so these stay allowed despite per-position overlap
    // elsewhere.
    expect(compileUserRegex(String.raw`(\w\d|ab)+`, '').ok).toBe(true);
    expect(compileUserRegex(String.raw`(\wa|ab)+`, '').ok).toBe(true);
    expect(compileUserRegex(String.raw`(\w\w|abc)+`, '').ok).toBe(true);
    expect(compileUserRegex('(ab|cd)+', '').ok).toBe(true);
  });

  it('flags quantifier characters inside character classes too (coarse heuristic)', () => {
    // Documented false positive: the adjacent-quantifier scan is a raw text
    // check, so even class-wrapped quantifier pairs trip it. Accepted bias
    // for hostile-input contexts — pin it so a silent loosening is noticed.
    expect(compileUserRegex('[+*]+', '').ok).toBe(false);
    expect(compileUserRegex('a[+*]b', '').ok).toBe(false);
  });

  it('allows character classes without quantifier pairs', () => {
    expect(compileUserRegex('[+]', '').ok).toBe(true);
    expect(compileUserRegex('[a-z]+', '').ok).toBe(true);
  });

  it('allows escaped parentheses so literal groups are not treated as regex groups', () => {
    expect(compileUserRegex(String.raw`\(a\)\+`, '').ok).toBe(true);
  });

  it('compiles a pattern at the length boundary', () => {
    expect(compileUserRegex('a'.repeat(256), '').ok).toBe(true);
  });
});

describe('compileUserRegex — rejected patterns', () => {
  it('rejects non-string patterns', () => {
    const result = compileUserRegex(42 as unknown as string, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pattern must be a string');
  });

  it('rejects the empty pattern', () => {
    const result = compileUserRegex('', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pattern is empty');
  });

  it('rejects patterns beyond 256 characters', () => {
    const result = compileUserRegex('a'.repeat(257), '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pattern exceeds 256 characters');
  });

  it('rejects nested quantifiers — the classic (a+)+$', () => {
    const result = compileUserRegex('(a+)+$', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('catastrophic backtracking');
  });

  it('rejects non-capturing nested quantifiers — (?:a+)+', () => {
    expect(compileUserRegex('(?:a+)+', '').ok).toBe(false);
  });

  it('rejects adjacent quantifiers — a++ and a*+', () => {
    expect(compileUserRegex('a++', '').ok).toBe(false);
    expect(compileUserRegex('a*+', '').ok).toBe(false);
  });

  it('rejects doubled quantifiers on alternation groups', () => {
    expect(compileUserRegex('(a|b)++', '').ok).toBe(false);
  });

  it('rejects greedy quantifiers inside lookarounds', () => {
    expect(compileUserRegex('(?=(a+))', '').ok).toBe(false);
  });

  it('rejects ambiguous quantified alternations with identical branches', () => {
    const result = compileUserRegex('(a|a)*', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('overlapping branches');
  });

  it('rejects ambiguous quantified alternations with prefix-related branches', () => {
    expect(compileUserRegex('(a|ab)+', '').ok).toBe(false);
  });

  it('rejects ambiguous alternations containing an empty branch', () => {
    expect(compileUserRegex('(a|)+', '').ok).toBe(false);
  });

  it('rejects ambiguous alternations hidden behind an escaped backslash', () => {
    // `\\(a|a)+` — `\\` matches a literal backslash, so the `(` IS a real
    // group. The old detector's one-character lookbehind (`pattern[i-1]`)
    // misread it as escaped `\(` and let the catastrophic form through.
    expect(compileUserRegex(String.raw`\\(a|a)+`, '').ok).toBe(false);
    expect(compileUserRegex(String.raw`x\\(a|a)+y`, '').ok).toBe(false);
  });

  it('rejects ambiguous alternations after a character class', () => {
    // `[(](a|a)+` — the `(` inside `[(]` is literal, but the old scanner
    // probed from it, found no matching `)` before the string ended, and took
    // the unbalanced-pattern early return — never reaching the REAL `(a|a)+`
    // later in the string.
    expect(compileUserRegex('[(](a|a)+', '').ok).toBe(false);
    expect(compileUserRegex('[ab](a|a)*', '').ok).toBe(false);
  });

  it('rejects ambiguous alternations hidden behind a named capture group', () => {
    // `(?<g>a|a)+` is semantically identical to `(a|a)+`, but the group
    // prefix strip only knew `(?:` and lookarounds: `?<g>a` stayed as the
    // first branch, the overlap comparison saw two disjoint-looking
    // branches, and the catastrophic pattern compiled and was handed out.
    expect(compileUserRegex('(?<g>a|a)+', '').ok).toBe(false);
    expect(compileUserRegex('(?<g>a|ab)+', '').ok).toBe(false);
    expect(compileUserRegex('(?<g>a|)+', '').ok).toBe(false);
    // Unicode identifier names must not re-open the hole.
    expect(compileUserRegex('(?<ñ>a|a)*', '').ok).toBe(false);
  });

  it('still strips lookahead and lookbehind prefixes before the branch check', () => {
    // The strip alternation was rewritten for named groups; these pin the
    // four lookaround spellings it must keep recognizing.
    expect(compileUserRegex('(?=a|a)+', '').ok).toBe(false);
    expect(compileUserRegex('(?!a|a)+', '').ok).toBe(false);
    expect(compileUserRegex('(?<=a|a)+', '').ok).toBe(false);
    expect(compileUserRegex('(?<!a|a)+', '').ok).toBe(false);
  });

  it('rejects ambiguous alternations nested under an outer quantifier', () => {
    // `((a|a))+` has the same ~2^n choice tree as `(a|a)+` — the outer
    // quantifier amplifies the nested choice — but the old scanner only
    // compared TOP-LEVEL branches of a quantified group. A quantified group
    // with a SINGLE branch (the nested group) was never flagged, and the
    // nested group itself carries no quantifier so the probe loop skipped
    // it too. The branch analysis now recurses into nested groups.
    expect(compileUserRegex('((a|a))+', '').ok).toBe(false);
    expect(compileUserRegex('((?:a|a))+', '').ok).toBe(false);
    expect(compileUserRegex('(?<g>(a|a))+', '').ok).toBe(false);
    expect(compileUserRegex('(((a|a)))+', '').ok).toBe(false);
    expect(compileUserRegex('((a|a)x)+', '').ok).toBe(false);
    expect(compileUserRegex('((a|ab))+', '').ok).toBe(false);
  });

  it('rejects character-class overlap between branches', () => {
    // Round 13: `\w` CONTAINS `a`, so both branches of `(\w|a)+` can match
    // 'a' — every character of a pure-'a' subject is a 2-way choice, the
    // same ~2^n tree as `(a|a)+` — but the branch strings `\w` and `a`
    // share no prefix, so the string-only overlap check never fired. Branch
    // comparison now intersects conservative single-token char sets.
    expect(compileUserRegex(String.raw`(\w|a)+`, '').ok).toBe(false);
    expect(compileUserRegex(String.raw`(a|\w)+`, '').ok).toBe(false);
    expect(compileUserRegex('([a-z]|b)+', '').ok).toBe(false);
    expect(compileUserRegex(String.raw`(\d|5)+`, '').ok).toBe(false);
    expect(compileUserRegex('(a|.)+', '').ok).toBe(false);
    expect(compileUserRegex('([ab]|a)+', '').ok).toBe(false);
  });

  it('rejects group-wrapped prefix-related branches', () => {
    // Round 13: `(a|(ab))+` is the long-rejected `(a|ab)+` with one
    // redundant wrap — but the wrapper made the branch string `(ab)`, which
    // has no string prefix relation to `a`. Branches are now compared
    // through unwrapGroupBranch first.
    expect(compileUserRegex('(a|(ab))+', '').ok).toBe(false);
    expect(compileUserRegex('((?:ab)|a)+', '').ok).toBe(false);
    expect(compileUserRegex(String.raw`(\w|(a))+`, '').ok).toBe(false);
    // The mirror case: unwrapping DESTROYS a prefix relation the raw
    // branches have. Raw `(\w)` is a prefix of `(\w)x`, so `((\w)x|(\w))+`
    // is the rejected `(\w|\wx)+` family with one wrapper — but the
    // unwrapped pair (`(\w)x` vs `\w`) shares no prefix and has unequal
    // token counts, so neither the string rules nor the char-set rules can
    // see it. Branches are therefore compared on BOTH raw and unwrapped
    // forms (security-review handoff 2026-09-01).
    expect(compileUserRegex(String.raw`((\w)x|(\w))+`, '').ok).toBe(false);
    expect(compileUserRegex('((a)x|(a))+', '').ok).toBe(false);
  });

  it('rejects intersecting fixed-length multi-token branches', () => {
    // Round 14: `\w\w` and `ab` share no prefix and neither is a single
    // token, but `\w\w` CONTAINS 'ab' — both branches match 'ab', so every
    // 'ab' pair of a subject is a 2-way choice under `+` (the same ~2^n
    // tree as `(a|a)+`). Branches that decompose into fixed-length
    // single-char token sequences are compared per position: languages
    // intersect iff lengths match and every position's char sets intersect.
    expect(compileUserRegex(String.raw`(\w\w|ab)+`, '').ok).toBe(false);
    expect(compileUserRegex(String.raw`(ab|\w\w)+`, '').ok).toBe(false);
    expect(compileUserRegex(String.raw`(\w\d|a5)+`, '').ok).toBe(false);
    expect(compileUserRegex('([a-c][a-c]|ab)+', '').ok).toBe(false);
    expect(compileUserRegex(String.raw`(a\w|ab)+`, '').ok).toBe(false);
    expect(compileUserRegex(String.raw`(\w{2}|ab)+`, '').ok).toBe(false); // {n} expanded
    expect(compileUserRegex('([ab][cd]|ac)+', '').ok).toBe(false);
  });

  it('still allows disjoint alternations and literal parens after the fix', () => {
    // Disjoint branches stay allowed even with an escape-pair or class before
    // them; and a class containing only literal parens is not a group.
    expect(compileUserRegex(String.raw`\\(foo|bar)+`, '').ok).toBe(true);
    expect(compileUserRegex('[(](foo|bar)+', '').ok).toBe(true);
    expect(compileUserRegex('[()]', '').ok).toBe(true);
    expect(compileUserRegex(String.raw`\(a\)\+`, '').ok).toBe(true);
  });

  it('reports the RegExp engine error for syntactically invalid patterns', () => {
    const result = compileUserRegex('([unclosed', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('capSubject', () => {
  it('exposes the documented 64 KiB subject bound', () => {
    expect(MAX_SUBJECT_LEN).toBe(64 * 1024);
  });

  it('returns short subjects untouched', () => {
    const line = 'a'.repeat(1000);
    expect(capSubject(line)).toBe(line);
  });

  it('returns a subject at exactly the bound untouched', () => {
    const line = 'b'.repeat(MAX_SUBJECT_LEN);
    expect(capSubject(line)).toBe(line);
  });

  it('truncates subjects beyond the bound to exactly MAX_SUBJECT_LEN characters', () => {
    const line = 'c'.repeat(MAX_SUBJECT_LEN + 100);
    const capped = capSubject(line);
    expect(capped.length).toBe(MAX_SUBJECT_LEN);
    expect(capped).toBe(line.slice(0, MAX_SUBJECT_LEN));
  });
});

describe('compileUserRegex — instance independence (shared-cache regression)', () => {
  // The module-level cache used to hand EVERY caller the SAME RegExp instance
  // for a given (pattern, flags). RegExp carries mutable state — `lastIndex`
  // — and `g`/`y`-flagged regexes advance it on every exec/test, so one
  // consumer's iterative scan silently corrupted every other consumer's
  // results for that pattern in the same process. This suite pins the
  // contract that each call returns an independent, pristine instance.

  it('returns a fresh RegExp per call even for cached patterns', () => {
    const a = compileUserRegex('ab', 'g');
    const b = compileUserRegex('ab', 'g');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.regex).not.toBe(b.regex);
  });

  it('does not leak lastIndex between callers of the same pattern', () => {
    const first = compileUserRegex('ab', 'g');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Consumer 1 iterates its regex (a normal find-all loop).
    expect(first.regex.exec('ab xx ab')?.index).toBe(0);
    expect(first.regex.exec('ab xx ab')?.index).toBe(6);
    expect(first.regex.lastIndex).toBeGreaterThan(0);

    // Consumer 2 compiles the same pattern and must start clean at index 0.
    const second = compileUserRegex('ab', 'g');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.regex.lastIndex).toBe(0);
    expect(second.regex.exec('ab xx ab')?.index).toBe(0);
  });

  it('keeps the returned regex behaviorally equivalent to new RegExp', () => {
    const pattern = '(foo|bar)+';
    const flags = 'gi';
    const compiled = compileUserRegex(pattern, flags);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const reference = new RegExp(pattern, flags);
    // Same semantics, source, and flags as a direct compile.
    expect(compiled.regex.source).toBe(reference.source);
    expect(compiled.regex.flags).toBe(reference.flags);
    for (const subject of ['BAR bar', 'foo', 'baz qux', '']) {
      expect(compiled.regex.test(subject), `subject ${JSON.stringify(subject)}`).toBe(
        reference.test(subject),
      );
    }
    // `lastIndex` is per-instance: mutating the caller's copy advances only
    // that copy, exactly as it would with new RegExp.
    compiled.regex.lastIndex = 1;
    expect(compiled.regex.test('bar bar')).toBe(reference.test('bar bar'));
  });

  it('caches rejected verdicts without caching a regex at all', () => {
    const first = compileUserRegex('(a|a)*', '');
    const second = compileUserRegex('(a|a)*', '');
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.reason).toBe(second.reason);
  });
});
