import { describe, expect, it } from 'vitest';
import {
  parseSageMemoryLine,
  SAGE_MEMORY_DETAIL,
} from '../src/components/history/sage-output-format.js';

/**
 * Unit tests for the structured-line parser and its underlying regex. These
 * tests focus on the contract between `parseSageMemoryLine` and the wire
 * shape produced by `packages/sage/src/retrieval/format.ts`. The render-level
 * behavior (kv rows, fallbacks, panel chrome) lives in
 * `sage-memory-block-render.test.tsx`; these tests pin the parser alone so
 * future changes to either side do not silently regress the other.
 */

describe('SAGE_MEMORY_DETAIL regex shape', () => {
  it('is anchored at line start and end and is not multiline', () => {
    // The pattern source starts with `^-` and ends with `$` (no `m` flag),
    // so it is strictly single-line. A stray prefix, suffix, or embedded
    // newline must NOT match. We pin the pattern source because
    // `RegExp.flags` only reports flag letters, not anchors.
    expect(SAGE_MEMORY_DETAIL.source.startsWith('^-')).toBe(true);
    expect(SAGE_MEMORY_DETAIL.source.endsWith('$')).toBe(true);
    expect(SAGE_MEMORY_DETAIL.flags.includes('m')).toBe(false);
    expect(SAGE_MEMORY_DETAIL.test('prefix - [fact] <memory id="m">x</memory>')).toBe(false);
    expect(SAGE_MEMORY_DETAIL.test('- [fact] <memory id="m">x</memory> suffix')).toBe(false);
    expect(SAGE_MEMORY_DETAIL.test('- [fact] <memory id="m">x\n</memory>')).toBe(false);
  });

  it('requires at least one label bracket pair', () => {
    // No `[label]` at all must not match — the producer always emits at
    // least one bracketed kind label.
    expect(SAGE_MEMORY_DETAIL.test('- <memory id="m">text</memory>')).toBe(false);
  });

  it('requires the <memory id="…"> wrapper', () => {
    expect(SAGE_MEMORY_DETAIL.test('- [fact] plain text')).toBe(false);
    expect(SAGE_MEMORY_DETAIL.test('- [fact] <memory id="m">text')).toBe(false);
    expect(SAGE_MEMORY_DETAIL.test('- [fact] <memory id="m">text</memo>')).toBe(false);
  });

  it('disallows unescaped quotes inside the id attribute', () => {
    // Producer escapes `"` to `&quot;`, so a literal `"` inside the id
    // value must NOT match — it would indicate tampered data.
    expect(SAGE_MEMORY_DETAIL.test('- [fact] <memory id="has"quote">x</memory>')).toBe(false);
  });
});

describe('parseSageMemoryLine — label variations', () => {
  it('parses a single bracketed label', () => {
    const parsed = parseSageMemoryLine('- [fact] <memory id="m">hello</memory>');
    expect(parsed).not.toBeNull();
    expect(parsed!.labels).toEqual(['fact']);
    expect(parsed!.id).toBe('m');
    expect(parsed!.text).toBe('hello');
    expect(parsed!.anchor).toBeUndefined();
    expect(parsed!.relation).toBeUndefined();
    expect(parsed!.tags).toBeUndefined();
  });

  it('parses multiple bracketed labels', () => {
    const parsed = parseSageMemoryLine('- [decision][high] <memory id="m">x</memory>');
    expect(parsed!.labels).toEqual(['decision', 'high']);
  });

  it('preserves label order from the wire format', () => {
    // The producer emits labels in a fixed order; the parser must not
    // reorder them so the rendered UI matches the producer's intent.
    const parsed = parseSageMemoryLine('- [warning][medium][stale] <memory id="m">x</memory>');
    expect(parsed!.labels).toEqual(['warning', 'medium', 'stale']);
  });
});

describe('parseSageMemoryLine — anchor and meta', () => {
  it('parses anchor only, no meta', () => {
    const parsed = parseSageMemoryLine('- [fact] <memory id="m">x</memory> (packages/tui)');
    expect(parsed!.anchor).toBe('packages/tui');
    expect(parsed!.relation).toBeUndefined();
    expect(parsed!.tags).toBeUndefined();
  });

  it('parses meta only, no anchor', () => {
    const parsed = parseSageMemoryLine(
      '- [fact] <memory id="m">x</memory> [relation=about_package; tags=tui]',
    );
    expect(parsed!.anchor).toBeUndefined();
    expect(parsed!.relation).toBe('about_package');
    expect(parsed!.tags).toEqual(['tui']);
  });

  it('parses both anchor and meta together', () => {
    const parsed = parseSageMemoryLine(
      '- [fact][critical] <memory id="m">x</memory> (packages/sage/src) [relation=about_directory; tags=fs,retrieval]',
    );
    expect(parsed!.anchor).toBe('packages/sage/src');
    expect(parsed!.relation).toBe('about_directory');
    expect(parsed!.tags).toEqual(['fs', 'retrieval']);
  });

  it('parses meta with only relation, no tags', () => {
    const parsed = parseSageMemoryLine('- [fact] <memory id="m">x</memory> [relation=about_file]');
    expect(parsed!.relation).toBe('about_file');
    expect(parsed!.tags).toBeUndefined();
  });

  it('parses meta with only tags, no relation', () => {
    const parsed = parseSageMemoryLine(
      '- [fact] <memory id="m">x</memory> [tags=alpha,beta,gamma]',
    );
    expect(parsed!.relation).toBeUndefined();
    expect(parsed!.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('trims whitespace around relation and tags values', () => {
    const parsed = parseSageMemoryLine(
      '- [fact] <memory id="m">x</memory> [relation= about_file ; tags= alpha , beta ]',
    );
    expect(parsed!.relation).toBe('about_file');
    expect(parsed!.tags).toEqual(['alpha', 'beta']);
  });

  it('drops empty tag entries from trailing-comma input', () => {
    const parsed = parseSageMemoryLine('- [fact] <memory id="m">x</memory> [tags=alpha,,beta,]');
    expect(parsed!.tags).toEqual(['alpha', 'beta']);
  });

  it('ignores unknown meta keys without dropping relation/tags', () => {
    // Defensive: if a future producer adds `[confidence=0.9]` or similar, the
    // parser must still surface the relation/tags it knows about.
    const parsed = parseSageMemoryLine(
      '- [fact] <memory id="m">x</memory> [confidence=0.9; relation=about_file; tags=alpha]',
    );
    expect(parsed!.relation).toBe('about_file');
    expect(parsed!.tags).toEqual(['alpha']);
  });
});

describe('parseSageMemoryLine — id and body', () => {
  it('preserves ids with hyphens, underscores, and dots', () => {
    const parsed = parseSageMemoryLine('- [fact] <memory id="mem-01_v2.legacy">x</memory>');
    expect(parsed!.id).toBe('mem-01_v2.legacy');
  });

  it('handles an empty body', () => {
    const parsed = parseSageMemoryLine('- [fact] <memory id="m"></memory>');
    expect(parsed!.text).toBe('');
  });

  it('unescapes all five XML entities in the body', () => {
    const parsed = parseSageMemoryLine(
      '- [fact] <memory id="m">A &amp; B &lt;C&gt; &#39;X&#39; &quot;Y&quot;</memory>',
    );
    expect(parsed!.text).toBe('A & B <C> \'X\' "Y"');
  });

  it('preserves escaped control chars as literal text (round-trip safe)', () => {
    // The producer escapes `\n`, `\r`, `\u2028`, `\u2029` as two-char
    // sequences. The parser intentionally does NOT materialize them
    // because the round-trip is ambiguous (a literal `\n` in the source
    // is indistinguishable from an escaped newline). Keeping the
    // two-char form means the bytes round-trip identically in either
    // direction.
    const parsed = parseSageMemoryLine('- [fact] <memory id="m">line1\\nline2\\u2028end</memory>');
    expect(parsed!.text).toBe('line1\\nline2\\u2028end');
    expect(parsed!.text).not.toContain('\n');
  });

  it('decodes only one layer of entity encoding (no recursive decode)', () => {
    // The producer is single-pass: it replaces `<` → `&lt;` and `&` →
    // `&amp;` exactly once. The decoder mirrors that — it does NOT
    // recursively re-decode. So a memory whose stored text already
    // contained the literal sequence `&lt;` arrives on the wire as
    // `&amp;lt;`, and decodes back to `&lt;` (the original stored text).
    // This pins the contract: decoder is the exact inverse of the
    // single-pass encoder.
    const parsed = parseSageMemoryLine('- [fact] <memory id="m">A &amp;lt;B&amp;gt;</memory>');
    expect(parsed!.text).toBe('A &lt;B&gt;');
  });
});

describe('parseSageMemoryLine — malformed input returns null', () => {
  it.each([
    ['empty string', ''],
    ['plain text', 'not a memory line'],
    ['missing bullet', '[fact] <memory id="m">x</memory>'],
    ['missing label brackets', '- <memory id="m">x</memory>'],
    ['missing opening memory tag', '- [fact] x</memory>'],
    ['missing closing memory tag', '- [fact] <memory id="m">x'],
    ['mismatched closing tag', '- [fact] <memory id="m">x</memo>'],
    ['embedded newline (single-line contract)', '- [fact] <memory id="m">x\n</memory>'],
    [
      'extra trailing suffix outside the suffix grammar',
      '- [fact] <memory id="m">x</memory> trailing-junk',
    ],
  ])('returns null for %s', (_label, line) => {
    expect(parseSageMemoryLine(line)).toBeNull();
  });
});

describe('parseSageMemoryLine — gate ↔ detail equivalence', () => {
  /**
   * The gate (`SAGE_MEMORY_LINE`) is used by `extractSageBlock` to decide
   * block membership; the detail regex here is used to structure each
   * accepted line. For every line the producer can emit, the detail regex
   * must accept it. These samples mirror the wire shape produced by
   * `packages/sage/src/retrieval/format.ts`.
   */
  const producerLines = [
    '- [fact] <memory id="m">plain</memory>',
    '- [decision][high] <memory id="m">two labels, no suffix</memory>',
    '- [warning][medium] <memory id="m">anchor only</memory> (packages/tui)',
    '- [fact][critical] <memory id="m">meta only</memory> [relation=about_package]',
    '- [decision][high] <memory id="m">full</memory> (packages/tui) [relation=about_package; tags=tui,build,workspace]',
    '- [fact] <memory id="m">truncated body…</memory>',
    '- [fact] <memory id="m">with &lt;entity&gt; &amp;amp;</memory>',
    '- [fact][critical][permanent] <memory id="mem-01_v2.legacy">persistent</memory> (packages/sage/src) [relation=about_directory; tags=fs]',
  ];

  it.each(producerLines)('detail regex parses producer-emitted line: %s', (line) => {
    expect(SAGE_MEMORY_DETAIL.test(line)).toBe(true);
    expect(parseSageMemoryLine(line)).not.toBeNull();
  });
});
