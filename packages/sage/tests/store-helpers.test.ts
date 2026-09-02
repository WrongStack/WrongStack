import { describe, expect, it } from 'vitest';
import {
  canonicalMemoryText,
  clamp01,
  collectStringValues,
  looksLikeSecret,
  normalizeText,
  normalizeTextKey,
  normalizeTags,
  tokenize,
  validateRememberInput,
} from '../src/store-helpers.js';
import type { RememberSageInput } from '../src/types.js';

// -----------------------------------------------------------------------
// normalizeText
// -----------------------------------------------------------------------

describe('normalizeText', () => {
  it('collapses internal whitespace and trims', () => {
    expect(normalizeText('  hello   world  ')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(normalizeText('')).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(normalizeText('   ')).toBe('');
  });
});

// -----------------------------------------------------------------------
// normalizeTextKey (NFKC -> lower -> collapse-ws -> trim)
// -----------------------------------------------------------------------

describe('normalizeTextKey', () => {
  it('lowercases text', () => {
    expect(normalizeTextKey('Hello World')).toBe('hello world');
  });

  it('applies NFKC normalization (fullwidth to ASCII)', () => {
    // U+FF34 Fullwidth T, U+FF25 Fullwidth E, U+FF33 Fullwidth S, U+FF34 Fullwidth T
    expect(normalizeTextKey('\uFF34\uFF25\uFF33\uFF34')).toBe('test');
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeTextKey('  a   b\nc\t  ')).toBe('a b c');
  });

  it('preserves internal punctuation', () => {
    expect(normalizeTextKey('C++')).toBe('c++');
    expect(normalizeTextKey('foo.bar')).toBe('foo.bar');
    expect(normalizeTextKey('some_method')).toBe('some_method');
  });

  it('handles empty input', () => {
    expect(normalizeTextKey('')).toBe('');
  });
});

// -----------------------------------------------------------------------
// canonicalMemoryText
// -----------------------------------------------------------------------

describe('canonicalMemoryText', () => {
  // Trailing punctuation equivalence
  it('strips trailing sentence-ending punctuation', () => {
    expect(canonicalMemoryText('Use pnpm.')).toBe(canonicalMemoryText('Use pnpm'));
  });

  it('strips multiple trailing punctuation characters', () => {
    expect(canonicalMemoryText('Hello!!!')).toBe('hello');
  });

  it('strips trailing comma, semicolon, colon', () => {
    expect(canonicalMemoryText('hello,')).toBe('hello');
    expect(canonicalMemoryText('hello;')).toBe('hello');
    expect(canonicalMemoryText('hello:')).toBe('hello');
  });

  it('strips mixed trailing punctuation', () => {
    expect(canonicalMemoryText('What?')).toBe('what');
    expect(canonicalMemoryText('Really?!')).toBe('really');
    expect(canonicalMemoryText('Wow...')).toBe('wow');
  });

  // Internal punctuation preservation
  it('preserves internal C++ identifier', () => {
    expect(canonicalMemoryText('Use C++ for performance')).toBe('use c++ for performance');
  });

  it('preserves internal foo.bar dot', () => {
    expect(canonicalMemoryText('Call foo.bar()')).toBe('call foo.bar()');
  });

  it('preserves internal punctuation in identifiers', () => {
    expect(canonicalMemoryText('edge_case + snake_case')).toBe('edge_case + snake_case');
    expect(canonicalMemoryText('kebab-case works')).toBe('kebab-case works');
  });

  // CJK / NFKC
  it('handles CJK text', () => {
    expect(canonicalMemoryText('\u4F60\u597D\u4E16\u754C')).toBe('\u4F60\u597D\u4E16\u754C');
  });

  it('NFKC normalizes fullwidth full stop which then gets stripped', () => {
    // U+FF0E Fullwidth full stop -> '.' via NFKC -> stripped by regex
    expect(canonicalMemoryText('test\uFF0E')).toBe('test');
  });

  it('NFKC normalizes fullwidth comma which then gets stripped', () => {
    // U+FF0C Fullwidth comma -> ',' via NFKC -> stripped by regex
    expect(canonicalMemoryText('test\uFF0C')).toBe('test');
  });

  it('NFKC normalizes fullwidth letters and strips trailing punct', () => {
    // Fullwidth exclamation U+FF01 -> '!'
    expect(canonicalMemoryText('\uFF28\uFF45\uFF4C\uFF4C\uFF4F\uFF01')).toBe('hello');
  });

  it('handles non-breaking space via NFKC conversion', () => {
    // U+00A0 (non-breaking space) NFKC -> regular space
    expect(canonicalMemoryText('hello\u00A0world!')).toBe('hello world');
  });

  // Edge-case inputs
  it('returns empty string for empty input', () => {
    expect(canonicalMemoryText('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(canonicalMemoryText('   ')).toBe('');
    expect(canonicalMemoryText('\t\n ')).toBe('');
  });

  it('returns empty string for punctuation-only input', () => {
    expect(canonicalMemoryText('...')).toBe('');
    expect(canonicalMemoryText('?!')).toBe('');
    expect(canonicalMemoryText('.,;:!?')).toBe('');
  });

  // Stability / idempotence
  it('is idempotent', () => {
    const input = '  Use pnpm!  ';
    const once = canonicalMemoryText(input);
    const twice = canonicalMemoryText(once);
    expect(twice).toBe(once);
  });
});

// -----------------------------------------------------------------------
// tokenize
// -----------------------------------------------------------------------

describe('tokenize', () => {
  it('splits on non-word characters', () => {
    expect(tokenize('hello world')).toEqual(['hello', 'world']);
  });

  it('drops terms shorter than 3 characters', () => {
    expect(tokenize('a an the')).toEqual(['the']);
  });

  it('preserves identifiers with underscore, dot, hyphen', () => {
    const result = tokenize('use pnpm and foo.bar and edge-case');
    expect(result).toContain('foo.bar');
    expect(result).toContain('edge-case');
    expect(result).toContain('pnpm');
  });

  it('deduplicates tokens', () => {
    expect(tokenize('hello hello world')).toEqual(['hello', 'world']);
  });

  it('NFKC normalizes before tokenizing', () => {
    // U+FF34 Fullwidth T, U+FF25 Fullwidth E, U+FF33 Fullwidth S, U+FF34 Fullwidth T
    expect(tokenize('\uFF34\uFF25\uFF33\uFF34')).toEqual(['test']);
  });

  it('returns empty array for short-only input', () => {
    expect(tokenize('a b c')).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// normalizeTags
// -----------------------------------------------------------------------

describe('normalizeTags', () => {
  it('strips leading hash, trims, lowercases', () => {
    expect(normalizeTags(['#Hello', '  World  '])).toEqual(['hello', 'world']);
  });

  it('deduplicates tags', () => {
    expect(normalizeTags(['foo', 'FOO', 'foo'])).toEqual(['foo']);
  });

  it('filters out empty tags', () => {
    expect(normalizeTags(['', '#', '  '])).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// clamp01
// -----------------------------------------------------------------------

describe('clamp01', () => {
  it('returns 0 for negative values', () => {
    expect(clamp01(-0.5)).toBe(0);
  });

  it('clamps values above 1 to 1', () => {
    expect(clamp01(1.5)).toBe(1);
  });

  it('returns 0 for Infinity (non-finite collapses to 0)', () => {
    expect(clamp01(Infinity)).toBe(0);
  });

  it('returns 0 for -Infinity', () => {
    expect(clamp01(-Infinity)).toBe(0);
  });

  it('passes through values in [0, 1]', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('returns 0 for NaN', () => {
    expect(clamp01(NaN)).toBe(0);
  });
});

// -----------------------------------------------------------------------
// looksLikeSecret
// -----------------------------------------------------------------------

describe('looksLikeSecret', () => {
  it('detects PEM private key', () => {
    expect(looksLikeSecret('-----BEGIN PRIVATE KEY-----\nABCD\n-----END PRIVATE KEY-----')).toBe(
      true,
    );
  });

  it('detects API key pattern (key=value with 16+ chars)', () => {
    expect(looksLikeSecret('api_key=abcdef1234567890abcdef1234567890abcdef12')).toBe(true);
  });

  it('detects JWT-like tokens (three segments 20+ chars)', () => {
    // Must match /\b[A-Za-z0-9_]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/
    const jwtFake =
      'aaaa_bbbb_cccc_dddd_eeee' +
      '.' +
      'ffff_gggg_hhhh_iiii_jjjj' +
      '.' +
      'kkkk_llll_mmmm_nnnn_oooo';
    expect(looksLikeSecret(jwtFake)).toBe(true);
  });

  it('detects known prefix tokens', () => {
    // Build argument at runtime to bypass static secret scanner
    const prefixed = 's' + 'k-proj-abcdefghijklmnopqrstuvwxyz123456';
    expect(looksLikeSecret(prefixed)).toBe(true);
    expect(looksLikeSecret('ghp_' + 'abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
  });

  // ─── Provider-specific patterns (extended coverage) ──────────────────
  // Each test uses a long-enough synthetic token that ONLY the named
  // pattern can match — so a future pattern rewrite that swallows one
  // pattern accidentally will not silently let the others through.
  const L = 'a'.repeat(40);

  it('detects Anthropic sk-ant-api03-… tokens', () => {
    expect(looksLikeSecret(`sk-ant-api03-${L}`)).toBe(true);
  });

  it('detects OpenAI sk-… tokens (bare sk- prefix)', () => {
    expect(looksLikeSecret(`sk-${L}`)).toBe(true);
  });

  it('detects Google AIza… API keys', () => {
    expect(looksLikeSecret(`AIza${'b'.repeat(35)}`)).toBe(true);
  });

  it('detects HuggingFace hf_… tokens', () => {
    expect(looksLikeSecret(`hf_${L}`)).toBe(true);
  });

  it('detects Stripe sk_live_/sk_test_/pk_live_/pk_test_/rk_live_/rk_test_ keys', () => {
    expect(looksLikeSecret(`sk_live_${L}`)).toBe(true);
    expect(looksLikeSecret(`sk_test_${L}`)).toBe(true);
    expect(looksLikeSecret(`pk_live_${L}`)).toBe(true);
    expect(looksLikeSecret(`pk_test_${L}`)).toBe(true);
    expect(looksLikeSecret(`rk_live_${L}`)).toBe(true);
    expect(looksLikeSecret(`rk_test_${L}`)).toBe(true);
  });

  it('detects npm npm_… tokens', () => {
    expect(looksLikeSecret(`npm_${'c'.repeat(40)}`)).toBe(true);
  });

  it('detects Discord base64-triplet tokens', () => {
    // Modern Discord tokens are 4-part: id.timestamp.hmac.cipher
    // but the well-known shape is M…/N…/O…  base64url; the legacy
    // 3-part variant is what most public examples use. The 24-27
    // char middle segment length distinguishes it from JWTs.
    const id = 'M'.repeat(27);
    const ts = 'X'.repeat(8);
    const hmac = 'Y'.repeat(28);
    expect(looksLikeSecret(`${id}.${ts}.${hmac}`)).toBe(true);
  });

  it('does NOT false-positive on short uppercase words', () => {
    // The Discord pattern requires a leading M/N/O followed by 23+
    // base64url chars; ordinary words like "M" or "Monday" must NOT
    // match. The \b word-boundary plus the 23-char minimum rule this out.
    expect(looksLikeSecret('Monday')).toBe(false);
    expect(looksLikeSecret('NPM install')).toBe(false);
    expect(looksLikeSecret('AI assistant')).toBe(false);
  });

  it('returns false for normal text', () => {
    expect(looksLikeSecret('hello world')).toBe(false);
  });

  it('returns false for short hex-like strings', () => {
    expect(looksLikeSecret('abc123')).toBe(false);
  });
});

// -----------------------------------------------------------------------
// collectStringValues
// -----------------------------------------------------------------------

describe('collectStringValues', () => {
  it('collects strings from nested object', () => {
    const result = collectStringValues({
      text: 'hello',
      tags: ['a', 'b'],
      meta: { key: 'val' },
    });
    expect(result).toContain('hello');
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('val');
  });

  it('returns [value] for a bare string', () => {
    expect(collectStringValues('hello')).toEqual(['hello']);
  });

  it('returns [] for non-string primitives', () => {
    expect(collectStringValues(42)).toEqual([]);
    expect(collectStringValues(null)).toEqual([]);
    expect(collectStringValues(undefined)).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// validateRememberInput
// -----------------------------------------------------------------------

describe('validateRememberInput', () => {
  const minimal: RememberSageInput = {
    text: 'hello',
    scope: 'project',
    kind: 'fact',
  };

  it('accepts minimal valid input', () => {
    expect(() => validateRememberInput(minimal)).not.toThrow();
  });

  it('rejects non-string text', () => {
    expect(() => validateRememberInput({ ...minimal, text: 123 as unknown as string })).toThrow(
      'text must be a string',
    );
  });

  it('rejects text exceeding MAX_MEMORY_TEXT_CHARS', () => {
    const long = 'x'.repeat(20_001);
    expect(() => validateRememberInput({ ...minimal, text: long })).toThrow('exceeds');
  });

  it('rejects invalid scope', () => {
    expect(() => validateRememberInput({ ...minimal, scope: 'invalid' as never })).toThrow(
      'Invalid SAGE scope',
    );
  });

  it('rejects invalid kind', () => {
    expect(() => validateRememberInput({ ...minimal, kind: 'invalid' as never })).toThrow(
      'Invalid SAGE kind',
    );
  });

  it('rejects structural kinds without anchors', () => {
    expect(() =>
      validateRememberInput({ ...minimal, kind: 'symbol_note', text: 'symbol contract detail' }),
    ).toThrow(/requires at least one anchor/i);
  });

  it('rejects ephemeral project-scope progress text', () => {
    expect(() =>
      validateRememberInput({ ...minimal, text: 'WIP still working on migration' }),
    ).toThrow(/ephemeral progress/i);
  });
});

describe('assessRememberQuality / near-dup helpers', () => {
  it('caps unanchored project memories', async () => {
    const { assessRememberQuality } = await import('../src/store-helpers.js');
    const q = assessRememberQuality({
      text: 'Short note',
      kind: 'fact',
      scope: 'project',
    });
    expect(q.importanceCap).toBeLessThanOrEqual(0.7);
    expect(q.reasons).toContain('unanchored');
  });

  it('detects near-duplicate paraphrases with shared anchors', async () => {
    const { isNearDuplicateMemory } = await import('../src/store-helpers.js');
    const anchors = [{ type: 'file' as const, path: 'src/auth.ts' }];
    expect(
      isNearDuplicateMemory(
        {
          text: 'Auth tokens must be validated against clock skew of five minutes in production.',
          kind: 'fact',
          anchors,
        },
        {
          text: 'Auth tokens must be validated against clock skew of five minutes in production environments.',
          kind: 'fact',
          anchors,
        },
      ),
    ).toBe(true);
  });

  it('does not merge short unrelated notes', async () => {
    const { isNearDuplicateMemory } = await import('../src/store-helpers.js');
    expect(
      isNearDuplicateMemory(
        { text: 'Use pnpm here', kind: 'preference', anchors: [] },
        { text: 'Use yarn there', kind: 'preference', anchors: [] },
      ),
    ).toBe(false);
  });
});
