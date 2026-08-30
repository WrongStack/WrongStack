/**
 * `scrubObjectShared` — the copy-on-write scrub the session read path uses.
 *
 * `scrubObject` rebuilds the whole graph whether or not anything was redacted.
 * On a resume that is almost pure waste: measured over a real 133 MB journal,
 * 488k nodes and 309k strings were rebuilt so that FOUR strings could be
 * redacted. This variant rebuilds only the spine above an actual redaction and
 * returns every clean subtree by reference.
 *
 * Two properties matter and both are pinned here: the OUTPUT must be
 * indistinguishable from `scrubObject`'s, and the SHARING must happen (or the
 * method is just a slower copy).
 */
import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';

const scrubber = new DefaultSecretScrubber();
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';

describe('DefaultSecretScrubber.scrubObjectShared', () => {
  it('produces the same output as scrubObject', () => {
    const build = () => ({
      type: 'tool_result',
      ts: '2026-08-30T10:00:00.000Z',
      content: [
        { type: 'text', text: 'ordinary output, nothing to see' },
        { type: 'text', text: `authorization: ${SECRET}` },
      ],
      meta: { nested: { deep: [1, 'two', null, true] } },
    });

    expect(scrubber.scrubObjectShared(build())).toEqual(scrubber.scrubObject(build()));
  });

  it('returns the input itself when nothing needed redacting', () => {
    // The whole point: a clean event costs no allocation at all.
    const clean = { type: 'user_input', content: 'run the tests please', tags: ['a', 'b'] };

    expect(scrubber.scrubObjectShared(clean)).toBe(clean);
  });

  it('shares every subtree that did not change, and rebuilds only the spine', () => {
    const cleanBranch = { note: 'untouched', items: [1, 2, 3] };
    const input = {
      clean: cleanBranch,
      dirty: { deep: { token: `Bearer ${'a'.repeat(40)}` } },
    };

    const out = scrubber.scrubObjectShared(input);

    // Root and the path down to the redaction are fresh…
    expect(out).not.toBe(input);
    expect(out.dirty).not.toBe(input.dirty);
    expect(out.dirty.deep).not.toBe(input.dirty.deep);
    // …the untouched sibling is the very same object, not a copy.
    expect(out.clean).toBe(cleanBranch);
    expect(out.clean.items).toBe(cleanBranch.items);
    // And the input is left exactly as it was.
    expect(input.dirty.deep.token).toContain('Bearer');
  });

  it('copies an array once and keeps its unchanged elements in place', () => {
    const keep = { text: 'fine' };
    const input = { blocks: [keep, { text: SECRET }, { text: 'also fine' }] };

    const out = scrubber.scrubObjectShared(input);

    expect(out.blocks).not.toBe(input.blocks);
    expect(out.blocks).toHaveLength(3);
    expect(out.blocks[0]).toBe(keep);
    expect(out.blocks[2]).toBe(input.blocks[2]);
    expect(out.blocks[1]?.text).not.toContain('sk-ant-');
  });

  it('terminates on a cycle, the way scrubObject does', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => scrubber.scrubObjectShared(cyclic)).not.toThrow();
  });

  it('leaves non-object leaves alone', () => {
    expect(scrubber.scrubObjectShared(null)).toBeNull();
    expect(scrubber.scrubObjectShared(42)).toBe(42);
    expect(scrubber.scrubObjectShared(undefined)).toBeUndefined();
  });
});

describe('anchor pre-scan — one combined pass', () => {
  // The pre-scan gates ALL regex work: if it says a string is clean, nothing
  // is redacted in it. Swapping 48 sequential `includes()` calls for one
  // alternation must therefore keep the predicate exactly, or a pattern goes
  // silently dead — the precise failure `Pattern.anchor` exists to prevent.
  const secrets = [
    `Bearer ${'x'.repeat(40)}`,
    'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
    'AKIAIOSFODNN7EXAMPLE',
    `API_KEY=${'k'.repeat(32)}`,
    SECRET,
  ];

  it('still redacts every anchored pattern', () => {
    for (const secret of secrets) {
      expect(scrubber.scrub(secret)).not.toBe(secret);
    }
  });

  it('still short-circuits ordinary text untouched', () => {
    for (const clean of [
      'src/index.ts:42 — refactored the loader',
      'npm run build && npm test',
      'the quick brown fox jumps over the lazy dog',
    ]) {
      expect(scrubber.scrub(clean)).toBe(clean);
    }
  });

  it('finds an anchor wherever it sits in the string', () => {
    // A combined alternation must not become position-anchored by accident —
    // `test()` on a non-global regex scans the whole string.
    const buried = `${'padding '.repeat(200)}${SECRET}${' trailing'.repeat(200)}`;
    expect(scrubber.scrub(buried)).not.toContain(SECRET);
  });
});
