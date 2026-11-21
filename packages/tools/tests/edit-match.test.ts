import { describe, expect, it } from 'vitest';
import {
  adjustIndent,
  findLadderMatches,
  firstLineIndent,
  nearestMatchHint,
  similarity,
} from '../src/_edit-match.js';

describe('_edit-match', () => {
  describe('findLadderMatches', () => {
    it('prefers exact matches and reports every occurrence', () => {
      const res = findLadderMatches('foo\nbar\nfoo\n', 'foo');
      expect(res?.tier).toBe('exact');
      expect(res?.matches).toHaveLength(2);
      expect(res?.matches.map((m) => m.startLine)).toEqual([1, 3]);
    });

    it('exact matches support sub-line needles', () => {
      const res = findLadderMatches('const foobar = 1;\n', 'foobar');
      expect(res?.tier).toBe('exact');
      expect(res?.matches[0]?.start).toBe(6);
    });

    it('falls back to trailing-whitespace matching', () => {
      const res = findLadderMatches('const a = 1;\n', 'const a = 1;   ');
      expect(res?.tier).toBe('trailing-whitespace');
      expect(res?.matches).toHaveLength(1);
      expect(res?.matches[0]).toMatchObject({ start: 0, end: 12, startLine: 1 });
    });

    it('falls back to indent-insensitive matching for long-enough needles', () => {
      const res = findLadderMatches(
        '    doThing(alpha, beta);\n    done();\n',
        'doThing(alpha, beta);\ndone();',
      );
      expect(res?.tier).toBe('whitespace-normalized');
      expect(res?.matches).toHaveLength(1);
    });

    it('refuses indent-insensitive matching for tiny needles', () => {
      expect(findLadderMatches('if (x) {\n  y();\n}\n', '  }')).toBeUndefined();
    });

    it('refuses an indentation SCALE change: same nesting ranks, different widths', () => {
      // F981: a 2-space block and its 4-space hallucination have identical
      // nesting ranks ([0,2,4] vs [0,4,8] both rank [0,1,2]), but the deltas
      // [0,-2,-4] are not a uniform shift. The first-line-only re-indent
      // cannot repair the scale, and splicing it over the file left the
      // continuation line ("  return True") at a level no open block uses —
      // CPython: IndentationError. The match must be refused, not applied.
      const file = 'def handler(event):\n  if event.ok:\n    process(event)\n  return True\n';
      const needle = 'def handler(event):\n    if event.ok:\n        process(event)';
      expect(findLadderMatches(file, needle)).toBeUndefined();
    });

    it('refuses a scale change through the fuzzy tier too', () => {
      // Interior typo keeps the trimmed-line tier from matching; the anchors
      // stay trim-exact, so before the fix the fuzzy tier admitted the same
      // non-uniform scale change and corrupted the file the same way.
      const file = 'def handler(event):\n  if event.ok:\n    process(event)\n  return True\n';
      const needle = 'def handler(event):\n    if event.ok :\n        process(event)';
      expect(findLadderMatches(file, needle)).toBeUndefined();
    });

    it('still admits a uniform shift with a deeper first line', () => {
      // The documented tier-3 feature: the whole block sits one level deeper
      // in the file, every line by the SAME delta (+4), internal scale intact.
      const file =
        'def handler(event):\n    if event.ok:\n        process(event)\n    return True\n';
      const needle = 'if event.ok:\n    process(event)';
      const res = findLadderMatches(file, needle);
      expect(res?.tier).toBe('whitespace-normalized');
      expect(res?.matches).toHaveLength(1);
      expect(res?.matches[0]?.startLine).toBe(2);
    });

    it('fuzzy tier requires matching first/last anchors', () => {
      const file = 'start() {\n  middle(1);\n  extra();\n}\n';
      // Last line differs → no anchor → no fuzzy match.
      expect(findLadderMatches(file, 'start() {\n  middle(2);\n  extra();\n};')).toBeUndefined();
    });

    it('fuzzy tier flags equally-scored candidates as ambiguous', () => {
      const block = 'function a() {\n  return compute(1, 2, 3);\n}';
      const res = findLadderMatches(
        `${block}\n\n${block}\n`,
        'function a() {\n  return compute(1, 2, 4);\n}',
      );
      expect(res?.tier).toBe('fuzzy');
      expect(res?.ambiguous).toBe(true);
      expect(res?.matches.length).toBe(2);
    });

    it('windows never overlap at line-based tiers', () => {
      // Needle spans 2 lines; the file repeats the line 3 times — only one
      // non-overlapping window pair should match, not two overlapping ones.
      const res = findLadderMatches('x\nx\nx\n', 'x \nx ');
      expect(res?.tier).toBe('trailing-whitespace');
      expect(res?.matches).toHaveLength(1);
    });

    it('exact tier never counts overlapping occurrences', () => {
      // The caller replaces non-overlapping (split/join or first-match), so
      // the exact scan must resume AFTER each occurrence — an overlap-
      // permitting scan would overcount self-overlapping needles and inflate
      // `replacements` / false-positive the uniqueness guard in edit.ts.
      const divider = findLadderMatches('==========', '========');
      expect(divider?.tier).toBe('exact');
      expect(divider?.matches.map((m) => m.start)).toEqual([0]);

      // A 2-char needle in a 3-char run has exactly one non-overlapping
      // occurrence — a unique-match edit must not be rejected as ambiguous.
      const run = findLadderMatches('aaa', 'aa');
      expect(run?.matches.map((m) => m.start)).toEqual([0]);

      // replace_all performs split/join: 4 replacements, reported as 4.
      expect(findLadderMatches('aaaaaaaa', 'aa')?.matches.map((m) => m.start)).toEqual([
        0, 2, 4, 6,
      ]);
    });
  });

  describe('adjustIndent', () => {
    it('adds indentation when the file is deeper than the needle', () => {
      const out = adjustIndent('if (a) {\n  b();\n}', '', '    ');
      expect(out.adjusted).toBe(true);
      expect(out.text).toBe('    if (a) {\n      b();\n    }');
    });

    it('removes indentation when the file is shallower than the needle', () => {
      const out = adjustIndent('    if (a) {\n      b();\n    }', '    ', '  ');
      expect(out.adjusted).toBe(true);
      expect(out.text).toBe('  if (a) {\n    b();\n  }');
    });

    it('leaves empty lines alone when adding indent', () => {
      const out = adjustIndent('a\n\nb', '', '  ');
      expect(out.text).toBe('  a\n\n  b');
    });

    it('does not guess on tabs-vs-spaces mismatches', () => {
      const out = adjustIndent('a', '\t', '  ');
      expect(out.adjusted).toBe(false);
      expect(out.text).toBe('a');
    });
  });

  describe('similarity', () => {
    it('is 1 for identical strings and 0-ish for disjoint ones', () => {
      expect(similarity('abc', 'abc')).toBe(1);
      expect(similarity('abc', 'xyz')).toBeLessThan(0.5);
    });

    it('scores single-char drift above the fuzzy threshold', () => {
      expect(similarity('return compute(1, 2, 3);', 'return compute(1, 2, 4);')).toBeGreaterThan(
        0.9,
      );
    });

    it('quick-rejects large length gaps without full DP', () => {
      expect(similarity('ab', 'ab'.repeat(50))).toBeLessThan(0.9);
    });
  });

  describe('firstLineIndent', () => {
    it('skips empty lines and reads the first real indent', () => {
      expect(firstLineIndent('\n\n    code();')).toBe('    ');
      expect(firstLineIndent('code();')).toBe('');
      expect(firstLineIndent('')).toBe('');
    });
  });

  describe('nearestMatchHint', () => {
    it('locates the closest window and returns a snippet', () => {
      const hint = nearestMatchHint(
        'first\nsecond\nconst alpha = computeValue(input, options);\n',
        'const alpha = computeValue(input, settings);',
      );
      expect(hint?.line).toBe(3);
      expect(hint?.snippet).toContain('computeValue(input, options)');
    });

    it('returns undefined when nothing is close', () => {
      expect(
        nearestMatchHint('completely unrelated content\n', 'zzzz no match at all'),
      ).toBeUndefined();
    });
  });
});
